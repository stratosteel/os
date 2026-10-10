/**
 * Layer 4, memory: the GitHub provider of `MemoryProvider`. The handover ledger and the state page live in a GitHub
 * repository and are read and written through the REST contents API. Behaviour verified on 2026-10-10 against
 * docs.github.com (repos/contents, git/blobs, rate limits, API versions; API version 2026-03-10, whose breaking changes do
 * not touch reading or writing a file):
 *  - Append: GET the file (content and blob sha), PUT the content with one more line and the sha it was read at. GitHub
 *    answers 409 when the file changed in between (optimistic concurrency); the provider re-reads and retries a bounded
 *    number of times. Nothing is ever overwritten: every write is the content just read plus one line.
 *  - A PUT whose outcome is unknown (5xx, network error, timeout) is never repeated blindly: the provider re-reads and
 *    counts the line before writing again, so an append the server applied is not duplicated.
 *  - The line is validated by the ledger rules of `ledger.ts` before any request is made.
 *  - Files over 1 MB come back from the contents API with encoding "none" and no content; the provider then reads the
 *    blob by its sha (git blobs API, up to 100 MB).
 *  - Rate limits (403 or 429): wait retry-after seconds; or, when x-ratelimit-remaining is 0, until x-ratelimit-reset;
 *    otherwise at least one minute, doubling on repeats. A wait longer than the configured maximum fails explicitly
 *    instead of hanging a worker. A 403 without a rate-limit signal is a permission error and fails at once.
 *  - The token comes only from the environment variable whose NAME the configuration gives (layers.yaml
 *    L4_memory.token_env). It is never read from the repository and never appears in an error message.
 *  - A missing ledger or state page is an explicit error (GitHub also answers 404 for a private repository the token
 *    cannot see), never an empty ledger, and the provider never creates the ledger file.
 */
import { formatLine, parseLine, type LedgerEntry } from '../ledger.js';
import { GITHUB_TOKEN_SHAPE, envVarNameErrors, type Manifest } from '../manifest.js';
import type { MemoryProvider } from '../providers.js';

/** REST API version sent with every request (X-GitHub-Api-Version). */
export const GITHUB_API_VERSION = '2026-03-10';
const DEFAULT_API = 'https://api.github.com';

export interface GitHubMemoryOptions {
  /** Repository as 'owner/name'. */
  repo: string;
  /** Path of the ledger file inside the repository, e.g. '02_PROGRAMS/HANDOVER_LEDGER.md'. */
  ledgerPath: string;
  /** Path of the state page, e.g. 'STATE_OF_THE_BUILD.md'. */
  statePagePath: string;
  /** NAME of the environment variable that holds the token (never the token). */
  tokenEnv: string;
  /** Branch to read and write; the repository's default branch when absent. */
  branch?: string;
  /** API root, default https://api.github.com (tests point it at a local fake). */
  apiBaseUrl?: string;
  /** Committer of the append commits; the token's user when absent. */
  committer?: { name: string; email: string };
  /** Attempts for one append across conflicts and unknown outcomes, and for one read across 5xx (default 5). */
  maxAttempts?: number;
  /** Rate-limit waits allowed per request (default 3). */
  maxRateLimitRetries?: number;
  /** Longest single rate-limit wait the provider accepts, in ms (default 60 000); a longer one fails explicitly. */
  maxRateLimitWaitMs?: number;
  /** Timeout of one HTTP request, in ms (default 30 000). */
  requestTimeoutMs?: number;
  /** Environment to read the token from (default process.env). */
  env?: Record<string, string | undefined>;
  /** fetch implementation (default the global fetch). */
  fetchImpl?: typeof fetch;
  /** Sleep used for rate-limit waits and retry backoff (tests record it instead of waiting). */
  sleep?: (ms: number, reason: 'rate_limit' | 'backoff') => Promise<void>;
  /** Clock in epoch milliseconds, for x-ratelimit-reset (default Date.now). */
  now?: () => number;
}

export type GitHubErrorKind = 'config' | 'auth' | 'permission' | 'not_found' | 'conflict' | 'rate_limited' | 'server' | 'network' | 'validation' | 'unexpected';

/** Explicit failure of the provider. The message carries the HTTP status and GitHub's own message, never a header or the token. */
export class GitHubMemoryError extends Error {
  constructor(message: string, readonly kind: GitHubErrorKind, readonly status: number | null = null) {
    super(message);
    this.name = 'GitHubMemoryError';
  }
}

interface ApiResponse {
  status: number;
  headers: Headers;
  json: unknown;
}

interface FileRead {
  text: string;
  sha: string;
}

type PutOutcome = 'written' | 'conflict' | 'unknown';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function pathErrors(label: string, p: unknown): string[] {
  if (typeof p !== 'string' || !p.trim()) return [`${label} is empty`];
  if (p.startsWith('/') || p.split('/').some((seg) => seg === '..' || seg === '')) return [`${label} must be a relative path inside the repository without empty or ".." segments`];
  return [];
}

/** How many lines of `text` are exactly `line`. */
function occurrences(text: string, line: string): number {
  return text.split('\n').filter((l) => l === line).length;
}

function githubMessage(json: unknown): string {
  const m = (json as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : '';
}

export class GitHubMemory implements MemoryProvider {
  private readonly owner: string;
  private readonly name: string;
  private readonly api: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, reason: 'rate_limit' | 'backoff') => Promise<void>;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly maxRateLimitRetries: number;
  private readonly maxRateLimitWaitMs: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly opts: GitHubMemoryOptions) {
    const errors = [
      ...(typeof opts.repo === 'string' && REPO.test(opts.repo) ? [] : ['repo must be "owner/name"']),
      ...pathErrors('ledgerPath', opts.ledgerPath),
      ...pathErrors('statePagePath', opts.statePagePath),
      ...envVarNameErrors(opts.tokenEnv).map((e) => `tokenEnv ${e}`),
    ];
    if (errors.length) throw new GitHubMemoryError(`GitHub memory configuration invalid: ${errors.join('; ')}`, 'config');
    [this.owner, this.name] = opts.repo.split('/');
    this.api = (opts.apiBaseUrl ?? DEFAULT_API).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.maxRateLimitRetries = opts.maxRateLimitRetries ?? 3;
    this.maxRateLimitWaitMs = opts.maxRateLimitWaitMs ?? 60_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  /** The token, read from the configured variable at the moment of use. The error names the variable, never a value. */
  private token(): string {
    const value = (this.opts.env ?? process.env)[this.opts.tokenEnv];
    if (typeof value !== 'string' || !value.trim()) {
      throw new GitHubMemoryError(`GitHub token environment variable ${this.opts.tokenEnv} is not set`, 'config');
    }
    return value.trim();
  }

  /** Text safe for an error message: the token and anything shaped like a GitHub token removed, length bounded. */
  private redact(text: string, token: string): string {
    let out = token ? text.split(token).join('[redacted]') : text;
    out = out.replace(GITHUB_TOKEN_SHAPE, '[redacted]');
    return out.length > 300 ? `${out.slice(0, 300)}...` : out;
  }

  private contentsUrl(filePath: string, withRef: boolean): string {
    const encoded = filePath.split('/').map(encodeURIComponent).join('/');
    const url = `${this.api}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.name)}/contents/${encoded}`;
    return withRef && this.opts.branch ? `${url}?ref=${encodeURIComponent(this.opts.branch)}` : url;
  }

  /** One HTTP exchange with the rate-limit rules applied. Network failures throw GitHubMemoryError(kind 'network'). */
  private async request(method: 'GET' | 'PUT', url: string, body?: unknown): Promise<ApiResponse> {
    const token = this.token();
    let rateLimitWaits = 0;
    let fallbackWaitMs = 60_000;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
            'User-Agent': 'stratosteel-os',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (e) {
        throw new GitHubMemoryError(`${method} ${this.describe(url)} failed without an HTTP answer: ${this.redact(errorText(e), token)}`, 'network');
      }
      let json: unknown = null;
      const text = await res.text().catch(() => '');
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const message = this.redact(githubMessage(json), token);
      const wait = this.rateLimitWaitMs(res.status, res.headers, message, fallbackWaitMs);
      if (wait === null) return { status: res.status, headers: res.headers, json };
      if (rateLimitWaits >= this.maxRateLimitRetries) {
        throw new GitHubMemoryError(`${method} ${this.describe(url)} is still rate limited after ${rateLimitWaits} waits (HTTP ${res.status}${message ? `: ${message}` : ''})`, 'rate_limited', res.status);
      }
      if (wait > this.maxRateLimitWaitMs) {
        throw new GitHubMemoryError(`${method} ${this.describe(url)} is rate limited for ${Math.ceil(wait / 1000)} s, more than the configured maximum wait of ${Math.ceil(this.maxRateLimitWaitMs / 1000)} s (HTTP ${res.status}${message ? `: ${message}` : ''})`, 'rate_limited', res.status);
      }
      rateLimitWaits += 1;
      fallbackWaitMs *= 2;
      await this.sleep(wait, 'rate_limit');
    }
  }

  /**
   * The wait a rate-limited answer asks for, or null when the answer is not a rate limit. GitHub: retry-after seconds;
   * x-ratelimit-remaining 0 means wait until x-ratelimit-reset (UTC epoch seconds); a secondary limit without either
   * header means at least one minute, increasing on repeats.
   */
  private rateLimitWaitMs(status: number, headers: Headers, message: string, fallbackMs: number): number | null {
    if (status !== 403 && status !== 429) return null;
    const retryAfter = headers.get('retry-after');
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
      const at = Date.parse(retryAfter);
      if (!Number.isNaN(at)) return Math.max(0, at - this.now());
    }
    if (headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(headers.get('x-ratelimit-reset'));
      return Number.isFinite(reset) ? Math.max(0, reset * 1000 - this.now()) : fallbackMs;
    }
    if (status === 429 || /rate limit/i.test(message)) return fallbackMs;
    return null;
  }

  private describe(url: string): string {
    return url.slice(this.api.length).replace(/\?.*$/, '');
  }

  private detail(res: ApiResponse): string {
    const message = this.redact(githubMessage(res.json), this.token());
    return `HTTP ${res.status}${message ? `: ${message}` : ''}`;
  }

  /** An explicit error for an answer that is not a success, a conflict or a server error. */
  private failure(res: ApiResponse, what: string): GitHubMemoryError {
    const detail = this.detail(res);
    if (res.status >= 500) return new GitHubMemoryError(`${what}: server error (${detail})`, 'server', res.status);
    if (res.status === 401) return new GitHubMemoryError(`${what}: the token was refused (${detail})`, 'auth', res.status);
    if (res.status === 403) return new GitHubMemoryError(`${what}: the token lacks permission (${detail})`, 'permission', res.status);
    if (res.status === 404) {
      return new GitHubMemoryError(`${what}: not found in ${this.opts.repo}${this.opts.branch ? ` on ${this.opts.branch}` : ''} (${detail}); the path is missing or the token cannot see the repository`, 'not_found', res.status);
    }
    if (res.status === 422) return new GitHubMemoryError(`${what}: refused by validation (${detail})`, 'validation', res.status);
    return new GitHubMemoryError(`${what}: unexpected answer (${detail})`, 'unexpected', res.status);
  }

  /** Read a file with its blob sha. 5xx and network failures are retried a bounded number of times; nothing else is. */
  private async getFile(filePath: string): Promise<FileRead> {
    let last: GitHubMemoryError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (attempt > 1) await this.sleep(Math.min(250 * 2 ** (attempt - 2), 4_000), 'backoff');
      let res: ApiResponse;
      try {
        res = await this.request('GET', this.contentsUrl(filePath, true));
      } catch (e) {
        if (e instanceof GitHubMemoryError && e.kind === 'network') {
          last = e;
          continue;
        }
        throw e;
      }
      if (res.status >= 500) {
        last = this.failure(res, `read ${filePath}`);
        continue;
      }
      if (res.status !== 200) throw this.failure(res, `read ${filePath}`);
      const file = res.json as { type?: unknown; sha?: unknown; content?: unknown; encoding?: unknown; size?: unknown } | null;
      if (!file || file.type !== 'file' || typeof file.sha !== 'string') {
        throw new GitHubMemoryError(`read ${filePath}: the path is not a file`, 'unexpected', res.status);
      }
      if (file.encoding === 'base64' && typeof file.content === 'string') {
        return { text: Buffer.from(file.content.replace(/\s+/g, ''), 'base64').toString('utf8'), sha: file.sha };
      }
      // Files over 1 MB: the contents API returns encoding "none" and an empty content; read the blob by its sha.
      return { text: await this.getBlob(filePath, file.sha), sha: file.sha };
    }
    throw new GitHubMemoryError(`read ${filePath} failed after ${this.maxAttempts} attempts: ${last?.message ?? 'no answer'}`, last?.kind ?? 'server', last?.status ?? null);
  }

  private async getBlob(filePath: string, sha: string): Promise<string> {
    const url = `${this.api}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.name)}/git/blobs/${encodeURIComponent(sha)}`;
    const res = await this.request('GET', url);
    if (res.status !== 200) throw this.failure(res, `read the blob of ${filePath}`);
    const blob = res.json as { content?: unknown; encoding?: unknown } | null;
    if (!blob || blob.encoding !== 'base64' || typeof blob.content !== 'string') {
      throw new GitHubMemoryError(`read the blob of ${filePath}: no base64 content`, 'unexpected', res.status);
    }
    return Buffer.from(blob.content.replace(/\s+/g, ''), 'base64').toString('utf8');
  }

  /** One conditional write. 'conflict': the file changed since `sha`. 'unknown': the server may or may not have applied it. */
  private async putFile(filePath: string, text: string, sha: string, message: string): Promise<PutOutcome> {
    const body: Record<string, unknown> = { message, content: Buffer.from(text, 'utf8').toString('base64'), sha };
    if (this.opts.branch) body.branch = this.opts.branch;
    if (this.opts.committer) body.committer = this.opts.committer;
    let res: ApiResponse;
    try {
      res = await this.request('PUT', this.contentsUrl(filePath, false), body);
    } catch (e) {
      if (e instanceof GitHubMemoryError && e.kind === 'network') return 'unknown';
      throw e;
    }
    if (res.status === 200 || res.status === 201) return 'written';
    if (res.status === 409) return 'conflict';
    if (res.status >= 500) return 'unknown';
    throw this.failure(res, `write ${filePath}`);
  }

  /** Append one validated ledger line. Returns the line as written. */
  async appendLedger(e: LedgerEntry): Promise<string> {
    const line = formatLine(e);
    this.token();
    const path = this.opts.ledgerPath;
    const commitMessage = `Append one handover ledger line (${e.from} to ${e.to}, ${e.status})`;
    // After a write with an unknown outcome: how often the line occurred in the content that write was based on.
    let unknownBase: number | null = null;
    let conflicts = 0;
    let unknowns = 0;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const file = await this.getFile(path);
      if (unknownBase !== null && occurrences(file.text, line) > unknownBase) return line;
      const separator = file.text.length && !file.text.endsWith('\n') ? '\n' : '';
      const outcome = await this.putFile(path, `${file.text}${separator}${line}\n`, file.sha, commitMessage);
      if (outcome === 'written') return line;
      if (outcome === 'conflict') conflicts += 1;
      if (outcome === 'unknown') {
        unknowns += 1;
        if (unknownBase === null) unknownBase = occurrences(file.text, line);
        await this.sleep(Math.min(250 * 2 ** (unknowns - 1), 4_000), 'backoff');
      }
    }
    if (unknownBase !== null) {
      const file = await this.getFile(path);
      if (occurrences(file.text, line) > unknownBase) return line;
    }
    throw new GitHubMemoryError(
      `ledger append to ${this.opts.repo}:${path} not done after ${this.maxAttempts} attempts (${conflicts} conflicts with other writers, ${unknowns} writes with unknown outcome, re-read each time: the line is not in the file)`,
      conflicts ? 'conflict' : 'server',
    );
  }

  /** The last n parsable ledger lines, oldest first, formatted as FileMemory does. */
  async readLedgerTail(n = 20): Promise<string[]> {
    const { text } = await this.getFile(this.opts.ledgerPath);
    const entries = text.split('\n').map(parseLine).filter((x): x is LedgerEntry => x !== null);
    return entries.slice(-n).map((x) => `${x.when} | ${x.from} | ${x.to} | ${x.task} | ${x.status} | ${x.evidence}`);
  }

  async readStatePage(): Promise<string> {
    return (await this.getFile(this.opts.statePagePath)).text;
  }
}

/** The provider configured by the manifest's L4_memory (repo, ledger_path, state_page, token_env, branch). */
export function githubMemoryFromManifest(m: Manifest, overrides: Partial<GitHubMemoryOptions> = {}): GitHubMemory {
  const l4 = m.layers.L4_memory;
  if (l4.provider !== 'github') throw new GitHubMemoryError(`L4_memory.provider is ${l4.provider}, not github`, 'config');
  if (!l4.token_env) throw new GitHubMemoryError('L4_memory.token_env is not configured: name the environment variable that holds the token', 'config');
  return new GitHubMemory({
    repo: l4.repo,
    ledgerPath: l4.ledger_path,
    statePagePath: l4.state_page,
    tokenEnv: l4.token_env,
    branch: l4.branch,
    ...overrides,
  });
}

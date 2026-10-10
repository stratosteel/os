/**
 * A local fake of the GitHub REST endpoints the memory provider uses (Node http server on 127.0.0.1, no network):
 *   GET /repos/{owner}/{repo}/contents/{path}[?ref=]   file JSON with base64 content and blob sha (encoding "none" above
 *                                                      the large-file threshold, as GitHub does above 1 MB)
 *   PUT /repos/{owner}/{repo}/contents/{path}          create or update; 409 when the given sha is not the current blob
 *                                                      sha, 422 when an existing file is updated without a sha
 *   GET /repos/{owner}/{repo}/git/blobs/{sha}          base64 blob content
 * Blob shas are real git blob shas. A bearer token is required (401 otherwise). Faults are injected per request by rules
 * matched in order: a canned answer (rate limits, 5xx), a concurrent writer that appends before the PUT is handled (the
 * PUT then meets a genuine sha mismatch), a PUT applied and answered with an error, a dropped connection, an answer that
 * echoes the Authorization header. Every request is recorded without its token.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CannedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export type Fault =
  | { kind: 'respond'; response: CannedResponse }
  | { kind: 'concurrent-append'; line: string }
  | { kind: 'apply-then'; response: CannedResponse }
  | { kind: 'drop' }
  | { kind: 'echo-auth'; status: number };

export interface FaultRule {
  method?: 'GET' | 'PUT';
  /** The request path must contain this text (for example 'contents/' or 'git/blobs'). */
  pathIncludes?: string;
  /** How many matching requests the rule applies to. */
  times: number;
  fault: Fault;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  authorized: boolean;
  tokenInUrl: boolean;
  apiVersion: string | undefined;
  accept: string | undefined;
  userAgent: string | undefined;
  /** For a PUT: the sha the client based its write on. */
  baseSha?: string;
  fault?: Fault['kind'];
  status: number;
}

interface StoredFile {
  content: Buffer;
  sha: string;
}

export function gitBlobSha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

export class FakeGitHub {
  readonly requests: RecordedRequest[] = [];
  /** Commits made by PUT, oldest first: the path and message of each. */
  readonly commits: { path: string; message: string; sha: string }[] = [];
  private readonly files = new Map<string, StoredFile>();
  private readonly blobs = new Map<string, Buffer>();
  private readonly rules: FaultRule[] = [];
  private server: http.Server | undefined;
  largeFileThreshold = 1_000_000;

  constructor(private readonly token: string, private readonly defaultBranch = 'main') {}

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private key(repo: string, branch: string | undefined, filePath: string): string {
    return `${repo}@${branch ?? this.defaultBranch}:${filePath}`;
  }

  seed(repo: string, filePath: string, text: string, branch?: string): void {
    const content = Buffer.from(text, 'utf8');
    const sha = gitBlobSha(content);
    this.files.set(this.key(repo, branch, filePath), { content, sha });
    this.blobs.set(sha, content);
  }

  read(repo: string, filePath: string, branch?: string): string | undefined {
    return this.files.get(this.key(repo, branch, filePath))?.content.toString('utf8');
  }

  fault(rule: FaultRule): void {
    this.rules.push({ ...rule });
  }

  private takeFault(method: string, path: string): Fault | undefined {
    const rule = this.rules.find((r) => r.times > 0 && (!r.method || r.method === method) && (!r.pathIncludes || path.includes(r.pathIncludes)));
    if (!rule) return undefined;
    rule.times -= 1;
    return rule.fault;
  }

  private appendRaw(key: string, line: string): void {
    const current = this.files.get(key);
    const text = current ? current.content.toString('utf8') : '';
    const content = Buffer.from(`${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`, 'utf8');
    const sha = gitBlobSha(content);
    this.files.set(key, { content, sha });
    this.blobs.set(sha, content);
    this.commits.push({ path: key, message: 'concurrent writer', sha });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const auth = req.headers.authorization;
    const rec: RecordedRequest = {
      method: req.method ?? '',
      path: url.pathname,
      query: url.search,
      authorized: auth === `Bearer ${this.token}`,
      tokenInUrl: (req.url ?? '').includes(this.token),
      apiVersion: req.headers['x-github-api-version'] as string | undefined,
      accept: req.headers.accept,
      userAgent: req.headers['user-agent'],
      status: 0,
    };
    this.requests.push(rec);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      rec.status = status;
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (!rec.authorized) return send(401, { message: 'Bad credentials' });

    const fault = this.takeFault(rec.method, rec.path);
    if (fault) rec.fault = fault.kind;
    if (fault?.kind === 'drop') {
      rec.status = -1;
      req.socket.destroy();
      return;
    }
    if (fault?.kind === 'respond') return send(fault.response.status, fault.response.body ?? { message: 'injected' }, fault.response.headers);
    if (fault?.kind === 'echo-auth') return send(fault.status, { message: `request carried ${auth}` });

    const contents = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(rec.path);
    const blob = /^\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/([0-9a-f]{40})$/.exec(rec.path);
    if (blob && rec.method === 'GET') {
      const content = this.blobs.get(blob[3]);
      if (!content) return send(404, { message: 'Not Found' });
      return send(200, { sha: blob[3], size: content.length, encoding: 'base64', content: content.toString('base64').replace(/(.{60})/g, '$1\n') });
    }
    if (!contents) return send(404, { message: 'Not Found' });
    const repo = `${decodeURIComponent(contents[1])}/${decodeURIComponent(contents[2])}`;
    const filePath = contents[3].split('/').map(decodeURIComponent).join('/');

    if (rec.method === 'GET') {
      const file = this.files.get(this.key(repo, url.searchParams.get('ref') ?? undefined, filePath));
      if (!file) return send(404, { message: 'Not Found' });
      const large = file.content.length > this.largeFileThreshold;
      return send(200, {
        type: 'file',
        name: filePath.split('/').pop(),
        path: filePath,
        sha: file.sha,
        size: file.content.length,
        encoding: large ? 'none' : 'base64',
        content: large ? '' : file.content.toString('base64').replace(/(.{60})/g, '$1\n'),
      });
    }

    if (rec.method === 'PUT') {
      let body: { message?: string; content?: string; sha?: string; branch?: string };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        return send(400, { message: 'Problems parsing JSON' });
      }
      rec.baseSha = body.sha;
      const key = this.key(repo, body.branch, filePath);
      if (fault?.kind === 'concurrent-append') this.appendRaw(key, fault.line);
      const current = this.files.get(key);
      if (typeof body.message !== 'string' || typeof body.content !== 'string') return send(422, { message: 'Invalid request.' });
      if (current && !body.sha) return send(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      if (current && body.sha !== current.sha) return send(409, { message: `${filePath} does not match ${body.sha}` });
      if (!current && body.sha) return send(404, { message: 'Not Found' });
      const content = Buffer.from(body.content, 'base64');
      const sha = gitBlobSha(content);
      this.files.set(key, { content, sha });
      this.blobs.set(sha, content);
      const commit = randomBytes(20).toString('hex');
      this.commits.push({ path: key, message: body.message, sha });
      if (fault?.kind === 'apply-then') return send(fault.response.status, fault.response.body ?? { message: 'injected after apply' }, fault.response.headers);
      return send(current ? 200 : 201, { content: { name: filePath.split('/').pop(), path: filePath, sha }, commit: { sha: commit, message: body.message } });
    }
    return send(405, { message: 'Method Not Allowed' });
  }
}

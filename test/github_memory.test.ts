/**
 * Layer 4 memory over GitHub (src/providers/github.ts), ROADMAP G4 code item 1 and "Next steps" 2.
 * Every case runs against the local fake GitHub API of test/fixtures/fake_github.ts; the fetch used by the provider is
 * guarded so that any request outside the fake fails the test: no real GitHub call is made.
 * Pinned: append through GET then PUT with the blob sha, bounded re-read and retry on 409, no duplicate after a write with
 * an unknown outcome (5xx, dropped connection), rate limits (403 and 429 with retry-after, x-ratelimit-reset, the
 * one-minute fallback, the maximum wait), a 403 permission error without retries, explicit 401 and 404, the large-file
 * blob path, branches, the ledger rules before any request, and the token: taken only from the configured variable name,
 * never in a URL, never in an error, a token pasted into the configuration refused without being echoed.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GITHUB_API_VERSION, GitHubMemory, GitHubMemoryError, githubMemoryFromManifest, type GitHubMemoryOptions } from '../src/providers/github.js';
import { parseManifest } from '../src/manifest.js';
import { ApprovalQueue } from '../src/approvals.js';
import { MockFiles, MockMail, MockRecords } from '../src/mock.js';
import { buildTools, type ToolDef } from '../src/tools.js';
import type { LedgerEntry } from '../src/ledger.js';
import { FakeGitHub } from './fixtures/fake_github.js';

const FAKE_CREDENTIAL = 'fake-api-credential-0001';
const WRONG_CREDENTIAL = 'wrong-credential-0002';
const REPO = 'tenant-x/knowledge';
const LEDGER = '02_PROGRAMS/HANDOVER_LEDGER.md';
const STATE = 'STATE_OF_THE_BUILD.md';
const HEADER = '# HANDOVER LEDGER (append-only)\n\nFormat: `YYYY-MM-DD HH:MM TZ | from | to | task | status | evidence`\n\n';
const LINE_1 = '2026-10-09 10:00 CEST | role-a | role-b | first handover | DONE | commit 0000001';
const LINE_2 = '2026-10-09 11:00 CEST | role-b | role-a | second handover | OPEN | path docs/example.md';
const ENTRY: LedgerEntry = { when: '2026-10-10 09:15 CEST', from: 'role-a', to: 'role-b', task: 'bus gate evidence', status: 'DONE', evidence: 'test github_memory' };
const ENTRY_LINE = '2026-10-10 09:15 CEST | role-a | role-b | bus gate evidence | DONE | test github_memory';
/** Built at run time so that no token-shaped literal sits in the source. */
const TOKEN_SHAPED = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

interface Rig {
  fake: FakeGitHub;
  base: string;
  sleeps: [number, string][];
  memory: (patch?: Partial<GitHubMemoryOptions>) => GitHubMemory;
  ledger: () => string;
}

async function rig(t: TestContext, seed = true, token = FAKE_CREDENTIAL): Promise<Rig> {
  const fake = new FakeGitHub(token);
  const base = await fake.start();
  t.after(() => fake.stop());
  if (seed) {
    fake.seed(REPO, LEDGER, `${HEADER}${LINE_1}\n${LINE_2}\n`);
    fake.seed(REPO, STATE, '# STATE OF THE BUILD\n\nrow 1: example workstream, measured 0\n');
  }
  const sleeps: [number, string][] = [];
  const guarded: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(base)) throw new Error(`test tried to reach ${url}`);
    return fetch(input, init);
  };
  const memory = (patch: Partial<GitHubMemoryOptions> = {}) =>
    new GitHubMemory({
      repo: REPO,
      ledgerPath: LEDGER,
      statePagePath: STATE,
      tokenEnv: 'OS_GITHUB_TOKEN',
      apiBaseUrl: base,
      env: { OS_GITHUB_TOKEN: token },
      fetchImpl: guarded,
      sleep: async (ms, reason) => {
        sleeps.push([ms, reason]);
      },
      now: () => Date.parse('2026-10-10T07:15:00Z'),
      ...patch,
    });
  return { fake, base, sleeps, memory, ledger: () => fake.read(REPO, LEDGER) ?? '' };
}

const methods = (r: Rig) => r.fake.requests.map((q) => `${q.method}${q.status === -1 ? ':drop' : `:${q.status}`}`);
const count = (text: string, line: string) => text.split('\n').filter((l) => l === line).length;
const rateLimitWaits = (r: Rig) => r.sleeps.filter(([, reason]) => reason === 'rate_limit').map(([ms]) => ms);

async function rejectsWith(p: Promise<unknown>, kind: string, pattern: RegExp): Promise<GitHubMemoryError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GitHubMemoryError, `expected GitHubMemoryError, got ${String(e)}`);
    assert.equal(e.kind, kind, e.message);
    assert.match(e.message, pattern);
    return e;
  }
  assert.fail('expected a rejection');
}

test('GitHub memory: appends one validated line through GET then PUT with the blob sha; tail and state page read back', async (t) => {
  const r = await rig(t);
  const m = r.memory();
  assert.equal(await m.appendLedger(ENTRY), ENTRY_LINE);
  assert.equal(r.ledger(), `${HEADER}${LINE_1}\n${LINE_2}\n${ENTRY_LINE}\n`, 'one line appended at the end, nothing else changed');
  assert.deepEqual(methods(r), ['GET:200', 'PUT:200']);
  const [get, put] = r.fake.requests;
  assert.equal(put.baseSha !== undefined && put.baseSha.length === 40, true, 'the PUT names the blob sha it was based on');
  for (const q of r.fake.requests) {
    assert.equal(q.authorized, true);
    assert.equal(q.tokenInUrl, false, 'the token travels in the Authorization header only');
    assert.equal(q.apiVersion, GITHUB_API_VERSION);
    assert.equal(q.accept, 'application/vnd.github+json');
    assert.equal(q.userAgent, 'stratosteel-os');
  }
  assert.equal(get.path, `/repos/${REPO}/contents/${LEDGER}`);
  assert.deepEqual(await m.readLedgerTail(2), [LINE_2, ENTRY_LINE]);
  assert.deepEqual(await m.readLedgerTail(), [LINE_1, LINE_2, ENTRY_LINE], 'the header lines are not ledger entries');
  assert.match(await m.readStatePage(), /^# STATE OF THE BUILD/);
  assert.match(r.fake.commits.at(-1)!.message, /Append one handover ledger line \(role-a to role-b, DONE\)/);
});

test('GitHub memory: the ledger rules run before any request; a missing token is named, never guessed', async (t) => {
  const r = await rig(t);
  await assert.rejects(r.memory().appendLedger({ ...ENTRY, task: 'typographic \u2014 dash' }), /typographic dash/);
  await assert.rejects(r.memory().appendLedger({ ...ENTRY, evidence: ' ' }), /evidence is empty/);
  await assert.rejects(r.memory().appendLedger({ ...ENTRY, when: '10.10.2026 09:15' }), /YYYY-MM-DD HH:MM TZ/);
  await rejectsWith(r.memory({ env: {} }).appendLedger(ENTRY), 'config', /GitHub token environment variable OS_GITHUB_TOKEN is not set/);
  await rejectsWith(r.memory({ env: { OS_GITHUB_TOKEN: '  ' } }).readStatePage(), 'config', /OS_GITHUB_TOKEN is not set/);
  assert.equal(r.fake.requests.length, 0, 'no request without a valid line and a token');
});

test('GitHub memory: a 409 from a concurrent writer is re-read and retried; the bound is explicit', async (t) => {
  const r = await rig(t);
  const other1 = '2026-10-10 09:14 CEST | role-b | role-a | concurrent one | DONE | commit 0000002';
  const other2 = '2026-10-10 09:14 CEST | role-c | role-a | concurrent two | DONE | commit 0000003';
  r.fake.fault({ method: 'PUT', times: 1, fault: { kind: 'concurrent-append', line: other1 } });
  r.fake.fault({ method: 'PUT', times: 1, fault: { kind: 'concurrent-append', line: other2 } });
  await r.memory().appendLedger(ENTRY);
  assert.deepEqual(methods(r), ['GET:200', 'PUT:409', 'GET:200', 'PUT:409', 'GET:200', 'PUT:200']);
  assert.equal(r.ledger(), `${HEADER}${LINE_1}\n${LINE_2}\n${other1}\n${other2}\n${ENTRY_LINE}\n`, 'the other writers\' lines are kept, ours lands once after them');

  const bounded = await rig(t);
  for (let i = 0; i < 5; i += 1) bounded.fake.fault({ method: 'PUT', times: 1, fault: { kind: 'concurrent-append', line: `2026-10-10 09:0${i} CEST | role-b | role-a | writer ${i} | DONE | commit 000001${i}` } });
  await rejectsWith(bounded.memory({ maxAttempts: 5 }).appendLedger(ENTRY), 'conflict', /not done after 5 attempts \(5 conflicts with other writers, 0 writes with unknown outcome/);
  assert.equal(count(bounded.ledger(), ENTRY_LINE), 0, 'our line is not in the file');
  assert.equal(bounded.ledger().split('\n').filter((l) => l.includes('| writer ')).length, 5, 'every concurrent line is kept');
});

test('GitHub memory: 403 and 429 rate limits wait as GitHub asks (retry-after, x-ratelimit-reset, one-minute fallback) and fail explicitly beyond the maximum', async (t) => {
  const secondary = await rig(t);
  secondary.fake.fault({ method: 'GET', times: 1, fault: { kind: 'respond', response: { status: 403, headers: { 'retry-after': '1' }, body: { message: 'You have exceeded a secondary rate limit.' } } } });
  secondary.fake.fault({ method: 'PUT', times: 1, fault: { kind: 'respond', response: { status: 429, headers: { 'retry-after': '2' }, body: { message: 'Too many requests' } } } });
  await secondary.memory().appendLedger(ENTRY);
  assert.deepEqual(rateLimitWaits(secondary), [1000, 2000]);
  assert.deepEqual(methods(secondary), ['GET:403', 'GET:200', 'PUT:429', 'PUT:200']);
  assert.equal(count(secondary.ledger(), ENTRY_LINE), 1);

  const primary = await rig(t);
  const reset = String(Date.parse('2026-10-10T07:15:05Z') / 1000);
  primary.fake.fault({ method: 'GET', times: 1, fault: { kind: 'respond', response: { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }, body: { message: 'API rate limit exceeded' } } } });
  await primary.memory().readStatePage();
  assert.deepEqual(rateLimitWaits(primary), [5000], 'waits until x-ratelimit-reset');

  const fallback = await rig(t);
  fallback.fake.fault({ method: 'GET', times: 1, fault: { kind: 'respond', response: { status: 403, body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' } } } });
  await fallback.memory().readStatePage();
  assert.deepEqual(rateLimitWaits(fallback), [60_000], 'no header: at least one minute');

  const tooLong = await rig(t);
  tooLong.fake.fault({ method: 'GET', times: 1, fault: { kind: 'respond', response: { status: 429, headers: { 'retry-after': '3600' } } } });
  await rejectsWith(tooLong.memory().appendLedger(ENTRY), 'rate_limited', /rate limited for 3600 s, more than the configured maximum wait of 60 s \(HTTP 429/);
  assert.deepEqual(rateLimitWaits(tooLong), [], 'nothing waited');
  assert.equal(tooLong.fake.requests.length, 1);

  const persistent = await rig(t);
  persistent.fake.fault({ method: 'GET', times: 10, fault: { kind: 'respond', response: { status: 403, headers: { 'retry-after': '1' }, body: { message: 'secondary rate limit' } } } });
  await rejectsWith(persistent.memory().readStatePage(), 'rate_limited', /still rate limited after 3 waits \(HTTP 403/);
  assert.deepEqual(rateLimitWaits(persistent), [1000, 1000, 1000]);

  const permission = await rig(t);
  permission.fake.fault({ method: 'PUT', times: 1, fault: { kind: 'respond', response: { status: 403, body: { message: 'Resource not accessible by personal access token' } } } });
  await rejectsWith(permission.memory().appendLedger(ENTRY), 'permission', /lacks permission \(HTTP 403: Resource not accessible by personal access token\)/);
  assert.deepEqual(methods(permission), ['GET:200', 'PUT:403'], 'a 403 without a rate-limit signal is not retried');
  assert.deepEqual(permission.sleeps, []);
  assert.equal(count(permission.ledger(), ENTRY_LINE), 0);
});

test('GitHub memory: 5xx reads are retried; a write with an unknown outcome is re-read and never duplicated', async (t) => {
  const read5xx = await rig(t);
  read5xx.fake.fault({ method: 'GET', times: 1, fault: { kind: 'respond', response: { status: 502, body: { message: 'Bad Gateway' } } } });
  await read5xx.memory().appendLedger(ENTRY);
  assert.deepEqual(methods(read5xx), ['GET:502', 'GET:200', 'PUT:200']);

  const notApplied = await rig(t);
  notApplied.fake.fault({ method: 'PUT', times: 1, fault: { kind: 'respond', response: { status: 503, body: { message: 'Service Unavailable' } } } });
  await notApplied.memory().appendLedger(ENTRY);
  assert.deepEqual(methods(notApplied), ['GET:200', 'PUT:503', 'GET:200', 'PUT:200'], 'the write is repeated only after a re-read shows it is missing');
  assert.equal(count(notApplied.ledger(), ENTRY_LINE), 1);

  const applied = await rig(t);
  applied.fake.fault({ method: 'PUT', times: 1, fault: { kind: 'apply-then', response: { status: 502, body: { message: 'Bad Gateway' } } } });
  assert.equal(await applied.memory().appendLedger(ENTRY), ENTRY_LINE);
  assert.deepEqual(methods(applied), ['GET:200', 'PUT:502', 'GET:200'], 'applied before the 502: found on re-read, no second write');
  assert.equal(count(applied.ledger(), ENTRY_LINE), 1);

  const dropped = await rig(t);
  dropped.fake.fault({ method: 'PUT', times: 1, fault: { kind: 'drop' } });
  await dropped.memory().appendLedger(ENTRY);
  assert.deepEqual(methods(dropped), ['GET:200', 'PUT:drop', 'GET:200', 'PUT:200']);
  assert.equal(count(dropped.ledger(), ENTRY_LINE), 1);

  const down = await rig(t);
  down.fake.fault({ method: 'GET', times: 10, fault: { kind: 'respond', response: { status: 500, body: { message: 'Server Error' } } } });
  await rejectsWith(down.memory({ maxAttempts: 3 }).readLedgerTail(), 'server', /read 02_PROGRAMS\/HANDOVER_LEDGER.md failed after 3 attempts: .*server error \(HTTP 500: Server Error\)/);
  assert.equal(down.fake.requests.length, 3);
});

test('GitHub memory: 401 and 404 are explicit; a missing ledger is never created and never read as empty', async (t) => {
  const empty = await rig(t, false);
  await rejectsWith(empty.memory().appendLedger(ENTRY), 'not_found', /read 02_PROGRAMS\/HANDOVER_LEDGER.md: not found in tenant-x\/knowledge \(HTTP 404: Not Found\); the path is missing or the token cannot see the repository/);
  await rejectsWith(empty.memory().readLedgerTail(), 'not_found', /not found/);
  await rejectsWith(empty.memory().readStatePage(), 'not_found', /read STATE_OF_THE_BUILD.md: not found/);
  assert.deepEqual(empty.fake.requests.map((q) => q.method), ['GET', 'GET', 'GET'], 'no PUT: the ledger file is not created');
  assert.equal(empty.ledger(), '');

  const r = await rig(t);
  await rejectsWith(r.memory({ env: { OS_GITHUB_TOKEN: WRONG_CREDENTIAL } }).readStatePage(), 'auth', /the token was refused \(HTTP 401: Bad credentials\)/);
});

test('GitHub memory: the token never appears in an error, a URL or a log; a token pasted into the configuration is refused unechoed', async (t) => {
  const r = await rig(t);
  r.fake.fault({ method: 'GET', times: 1, fault: { kind: 'echo-auth', status: 403 } });
  const e = await rejectsWith(r.memory().readStatePage(), 'permission', /request carried Bearer \[redacted\]/);
  for (const text of [e.message, String(e), e.stack ?? '', JSON.stringify(e)]) assert.ok(!text.includes(FAKE_CREDENTIAL), 'token leaked');
  const realistic = await rig(t, true, TOKEN_SHAPED);
  realistic.fake.fault({ method: 'PUT', times: 1, fault: { kind: 'echo-auth', status: 422 } });
  const shaped = await rejectsWith(realistic.memory().appendLedger(ENTRY), 'validation', /refused by validation \(HTTP 422: request carried Bearer \[redacted\]\)/);
  for (const text of [shaped.message, String(shaped), shaped.stack ?? '']) assert.ok(!text.includes(TOKEN_SHAPED), 'token leaked');

  for (const tokenEnv of [TOKEN_SHAPED, 'lowercase_name', '1STARTS_WITH_DIGIT', '']) {
    let thrown: unknown;
    try {
      r.memory({ tokenEnv });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof GitHubMemoryError && thrown.kind === 'config', `tokenEnv ${tokenEnv.slice(0, 3)} must be refused`);
    assert.ok(!String(thrown).includes(TOKEN_SHAPED) && !(thrown.stack ?? '').includes(TOKEN_SHAPED), 'a token-shaped value is never echoed');
  }

  const yaml = await readFile(path.resolve('layers.yaml'), 'utf8');
  assert.match(yaml, /token_env: OS_GITHUB_TOKEN/);
  let manifestError: unknown;
  try {
    parseManifest(yaml.replace('token_env: OS_GITHUB_TOKEN', `token_env: ${TOKEN_SHAPED}`));
  } catch (err) {
    manifestError = err;
  }
  assert.ok(manifestError, 'the manifest refuses a token in token_env');
  assert.match(String(manifestError), /looks like a token/);
  assert.ok(!String(manifestError).includes(TOKEN_SHAPED), 'the manifest error does not repeat the token');
  assert.throws(() => parseManifest(yaml.replace('token_env: OS_GITHUB_TOKEN', 'token_env: os_github_token')), /environment variable name/);
});

test('GitHub memory: files over the large-file threshold are read through the blob API; a configured branch is read and written', async (t) => {
  const r = await rig(t);
  r.fake.largeFileThreshold = 100;
  const m = r.memory();
  await m.appendLedger(ENTRY);
  assert.deepEqual(r.fake.requests.map((q) => `${q.method} ${q.path.includes('/git/blobs/') ? 'blob' : 'contents'}`), ['GET contents', 'GET blob', 'PUT contents']);
  assert.equal(count(r.ledger(), ENTRY_LINE), 1);
  assert.deepEqual(await m.readLedgerTail(1), [ENTRY_LINE]);

  const b = await rig(t);
  b.fake.seed(REPO, LEDGER, `${HEADER}${LINE_1}\n`, 'memory');
  await b.memory({ branch: 'memory' }).appendLedger(ENTRY);
  assert.equal(b.fake.read(REPO, LEDGER, 'memory'), `${HEADER}${LINE_1}\n${ENTRY_LINE}\n`);
  assert.equal(count(b.ledger(), ENTRY_LINE), 0, 'the default branch is untouched');
  assert.deepEqual(b.fake.requests.map((q) => q.query), ['?ref=memory', '']);
});

test('GitHub memory: configured from layers.yaml L4_memory; the MCP ledger and state tools run over it unchanged', async (t) => {
  const r = await rig(t, false);
  const manifest = parseManifest(await readFile(path.resolve('layers.yaml'), 'utf8'));
  const l4 = manifest.layers.L4_memory;
  r.fake.seed(l4.repo, l4.ledger_path, `${HEADER}${LINE_1}\n`);
  r.fake.seed(l4.repo, l4.state_page, '# STATE OF THE BUILD\n');
  const guarded: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(r.base)) throw new Error(`test tried to reach ${url}`);
    return fetch(input, init);
  };
  const memory = githubMemoryFromManifest(manifest, { apiBaseUrl: r.base, env: { [l4.token_env!]: FAKE_CREDENTIAL }, fetchImpl: guarded });
  const dir = await mkdtemp(path.join(tmpdir(), 'os-gh-tools-'));
  const tools = buildTools({
    providers: { mail: new MockMail(), files: new MockFiles(), records: new MockRecords(), memory },
    approvals: new ApprovalQueue(path.join(dir, 'approvals.jsonl')),
    caller: 'role-a',
    role: 'agent',
  });
  const tool = (name: string): ToolDef => tools.find((x) => x.name === name)!;
  const line = await tool('ledger_append').handler({ when: '2026-10-10 09:30 CEST', to: 'role-b', task: 'tool over GitHub', status: 'OPEN', evidence: 'test github_memory' });
  assert.equal(line, '2026-10-10 09:30 CEST | role-a | role-b | tool over GitHub | OPEN | test github_memory');
  assert.deepEqual(await tool('ledger_tail').handler({ n: 1 }), [line]);
  assert.equal(await tool('state_of_build').handler({}), '# STATE OF THE BUILD\n');
  assert.equal(count(r.fake.read(l4.repo, l4.ledger_path) ?? '', line as string), 1);

  assert.throws(() => githubMemoryFromManifest({ ...manifest, layers: { ...manifest.layers, L4_memory: { ...l4, provider: 'none' } } }), /not github/);
  assert.throws(() => githubMemoryFromManifest({ ...manifest, layers: { ...manifest.layers, L4_memory: { ...l4, token_env: undefined } } }), /token_env is not configured/);
});

/**
 * Pins finding OS-APP-01 of the independent review of 2026-10-07: the approval race.
 * Deciding an approval is an atomic one-decision transition across queue instances and processes that share one JSONL
 * file: exactly one decision is persisted and the loser gets an explicit "already approved" or "already rejected" error,
 * never success. Storage errors are explicit: an unreadable store is not an empty queue, and append failures propagate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApprovalQueue, type ApprovalStatus, type ApprovalView } from '../src/approvals.js';

const REQUEST = {
  requestedBy: 'worker-1',
  category: 'customer_quote',
  summary: 'Release quote CN-2026-0101 rev 2',
  payload: { jobId: 'DOP-2026-001' },
  reasons: ['customer_quote always needs a person'],
};

async function freshQueueFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'os-race-'));
  return path.join(dir, 'approvals.jsonl');
}

async function pendingRequest(file: string): Promise<string> {
  return (await new ApprovalQueue(file).request(REQUEST)).id;
}

async function decisionEvents(file: string, id: string): Promise<unknown[]> {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { type: string; data: { id: string } })
    .filter((e) => e.type === 'decision' && e.data.id === id);
}

/** Opens when two parties have arrived, or after a timeout, so a serialized implementation never deadlocks on it. */
function twoPartyGate(timeoutMs = 300): { arrive(): Promise<void> } {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  setTimeout(() => open(), timeoutMs).unref();
  return {
    async arrive() {
      arrived += 1;
      if (arrived >= 2) open();
      await opened;
    },
  };
}

/** The review's harness: each queue holds its list() result until both have read the request as pending. */
class HeldQueue extends ApprovalQueue {
  constructor(file: string, private readonly gate: { arrive(): Promise<void> }) {
    super(file);
  }
  override async list(status?: ApprovalStatus): Promise<ApprovalView[]> {
    const views = await super.list(status);
    await this.gate.arrive();
    return views;
  }
}

test('OS-APP-01: two queues racing approved against rejected persist exactly one decision; the loser gets an explicit error', async () => {
  const file = await freshQueueFile();
  const id = await pendingRequest(file);
  const gate = twoPartyGate();
  const settled = await Promise.allSettled([
    new HeldQueue(file, gate).decide(id, 'approved', 'Person A'),
    new HeldQueue(file, gate).decide(id, 'rejected', 'Person B'),
  ]);
  const fulfilled = settled.filter((s): s is PromiseFulfilledResult<ApprovalView> => s.status === 'fulfilled');
  const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  assert.equal(fulfilled.length, 1, `exactly one decision may succeed, ${fulfilled.length} did`);
  assert.equal(rejected.length, 1);
  assert.equal((await decisionEvents(file, id)).length, 1, 'exactly one decision event in the file');
  const winner = fulfilled[0].value;
  assert.equal(String(rejected[0].reason?.message), `approval ${id} already ${winner.status}`);
  const rebuilt = (await new ApprovalQueue(file).list()).find((v) => v.id === id);
  assert.equal(rebuilt?.status, winner.status);
  assert.equal(rebuilt?.decision?.decidedBy, winner.decision?.decidedBy);
});

test('OS-APP-01: repeated plain races between two instances keep exactly one decision each', async () => {
  const file = await freshQueueFile();
  for (let round = 0; round < 20; round += 1) {
    const id = await pendingRequest(file);
    const settled = await Promise.allSettled([
      new ApprovalQueue(file).decide(id, 'approved', 'Person A'),
      new ApprovalQueue(file).decide(id, 'rejected', 'Person B'),
    ]);
    assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1, `round ${round}`);
    assert.equal((await decisionEvents(file, id)).length, 1, `round ${round}`);
  }
});

const QUEUE_MODULE = new URL('../src/approvals.js', import.meta.url).href;
const RACER = [
  'const [moduleUrl, file, id, decision, by] = process.argv.slice(1);',
  'const { ApprovalQueue } = await import(moduleUrl);',
  'const queue = new ApprovalQueue(file);',
  "process.stdout.write('ready\\n');",
  "process.stdin.once('data', async () => {",
  '  try { await queue.decide(id, decision, by); process.stdout.write(JSON.stringify({ ok: true }) + "\\n"); }',
  '  catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + "\\n"); }',
  '  process.exit(0);',
  '});',
].join('\n');

/** One OS process that decides the approval when it receives "go" on stdin. */
function racer(file: string, id: string, decision: 'approved' | 'rejected', by: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', RACER, QUEUE_MODULE, file, id, decision, by], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('ready\n')) resolve();
    });
    child.on('exit', () => reject(new Error(`racer exited before it was ready: ${err}`)));
  });
  const result = new Promise<void>((resolve, reject) => {
    child.on('exit', () => {
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (!line) return reject(new Error(`racer gave no result: ${err}`));
      const r = JSON.parse(line) as { ok: boolean; error?: string };
      if (r.ok) resolve();
      else reject(new Error(r.error));
    });
  });
  return { child, ready, result };
}

test('OS-APP-01: two OS processes racing on one file persist exactly one decision', async () => {
  const file = await freshQueueFile();
  const id = await pendingRequest(file);
  const a = racer(file, id, 'approved', 'Person A');
  const b = racer(file, id, 'rejected', 'Person B');
  await Promise.all([a.ready, b.ready]);
  a.child.stdin.write('go\n');
  b.child.stdin.write('go\n');
  const settled = await Promise.allSettled([a.result, b.result]);
  assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1, JSON.stringify(settled));
  const lost = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  assert.match(String(lost?.reason?.message), /^approval .+ already (approved|rejected)$/);
  assert.equal((await decisionEvents(file, id)).length, 1);
});

test('OS-APP-01: storage errors are explicit: an unreadable store is not an empty queue; append failures propagate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'os-store-'));
  const directoryAsStore = new ApprovalQueue(dir);
  await assert.rejects(directoryAsStore.list(), /approval store .+ cannot be read/);
  await assert.rejects(directoryAsStore.decide('any-id', 'approved', 'Person A'), /approval store .+ cannot be read/);

  const file = await freshQueueFile();
  await pendingRequest(file);
  await appendFile(file, '{"type":"decision","data":{"id"\n');
  await assert.rejects(new ApprovalQueue(file).list(), /line 2 is not a valid approval event/);

  await assert.rejects(new ApprovalQueue(path.join(dir, 'missing', 'approvals.jsonl')).request(REQUEST), /ENOENT/);
});

test('OS-APP-01: a held lock blocks with an explicit error; a stale lock left by a crashed writer is broken', async () => {
  const file = await freshQueueFile();
  const id = await pendingRequest(file);
  const lock = `${file}.lock`;
  await writeFile(lock, JSON.stringify({ token: 'another-writer', pid: 0 }));
  await assert.rejects(new ApprovalQueue(file, undefined, { lockTimeoutMs: 150 }).decide(id, 'approved', 'Person A'), /is locked by another writer/);
  assert.equal((await decisionEvents(file, id)).length, 0, 'nothing is written without the lock');

  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  const view = await new ApprovalQueue(file, undefined, { lockTimeoutMs: 150, staleLockMs: 30_000 }).decide(id, 'approved', 'Person A');
  assert.equal(view.status, 'approved');
  assert.equal((await decisionEvents(file, id)).length, 1);
  await assert.rejects(readFile(lock), /ENOENT/);
});

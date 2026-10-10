/**
 * One independent worker process for the A05 and A09 integration tests:
 *   node dist/test/fixtures/send_worker.js <config.json>
 *
 * It reads the input event fixture, prints "ready", waits at the barrier file if one is configured, then processes the
 * same event `deliveries` times (create the intent for the event's key, dispatch it), waits until the record settles
 * (no live lease; accepted, observed in Sent, failed or blocked) and prints one line "result:<json>" with its outcomes
 * and the send record exactly as it reads it.
 *
 * Fault injection by configuration, at the dispatcher's named points:
 *  - pauseAt: print "paused:<point>" and wait for a line on stdin; meanwhile the parent stops the process with SIGSTOP,
 *    lets the lease expire and resumes it with SIGCONT before it writes the line.
 *  - crashAt: print "crash:<point>" and kill this process with SIGKILL (no cleanup, nothing more is written).
 */
import { access, readFile } from 'node:fs/promises';
import { SendRecordStore, hasUnresolvedAttempt, sendRecordSnapshot, type SendIntentInput, type SendRecord } from '../../src/send_record.js';
import { SendDispatcher, type DispatchPoint } from '../../src/send_dispatcher.js';
import { FakeTransport } from '../../src/transport.js';

interface WorkerConfig {
  storeDir: string;
  transportDir: string;
  fixturePath: string;
  worker: string;
  task: string;
  deliveries: number;
  leaseMs: number;
  barrierPath?: string;
  pauseAt?: DispatchPoint;
  crashAt?: DispatchPoint;
  reconcileBackoffMs?: number;
  retryBackoffMs?: number;
  /** Render a different body for the same key, as a regenerated draft would. */
  regenerateDraft?: boolean;
  settleTimeoutMs?: number;
}

interface EventFixture {
  event: { id: string; type: string; intent: SendIntentInput };
}

const out = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const config = JSON.parse(await readFile(process.argv[2], 'utf8')) as WorkerConfig;
const fixture = JSON.parse(await readFile(config.fixturePath, 'utf8')) as EventFixture;

let stdinText = '';
const stdinWaiters: (() => void)[] = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  stdinText += chunk;
  while (stdinText.includes('\n') && stdinWaiters.length) {
    stdinText = stdinText.slice(stdinText.indexOf('\n') + 1);
    stdinWaiters.shift()!();
  }
});
const nextStdinLine = () =>
  new Promise<void>((resolve) => {
    if (stdinText.includes('\n')) {
      stdinText = stdinText.slice(stdinText.indexOf('\n') + 1);
      resolve();
    } else stdinWaiters.push(resolve);
  });

const store = new SendRecordStore(config.storeDir);
const transport = new FakeTransport(config.transportDir);
const dispatcher = new SendDispatcher({
  store,
  transport,
  worker: config.worker,
  leaseMs: config.leaseMs,
  reconcileBackoffMs: config.reconcileBackoffMs ?? 50,
  retryBackoffMs: config.retryBackoffMs ?? 20,
  onPoint: async (point) => {
    if (point === config.crashAt) {
      out(`crash:${point}`);
      process.kill(process.pid, 'SIGKILL');
      await new Promise<void>(() => undefined);
    }
    if (point === config.pauseAt) {
      out(`paused:${point}`);
      await nextStdinLine();
    }
  },
});

async function settle(intentId: string): Promise<SendRecord> {
  const deadline = Date.now() + (config.settleTimeoutMs ?? 15_000);
  for (;;) {
    const r = await store.read(intentId);
    const leaseFree = !r.lease || r.lease.released || Date.parse(r.lease.until) <= Date.now();
    const idle = r.state === 'approved' || (r.state === 'queued' && !hasUnresolvedAttempt(r));
    const done = r.state === 'accepted' || r.state === 'observed_sent' || r.state === 'failed' || r.blocked !== undefined || idle;
    if ((leaseFree && done) || Date.now() > deadline) return r;
    await sleep(20);
  }
}

out('ready');
if (config.barrierPath) {
  for (;;) {
    try {
      await access(config.barrierPath);
      break;
    } catch {
      await sleep(1);
    }
  }
}

const deliveries: Record<string, unknown>[] = [];
let intentId = '';
for (let i = 1; i <= config.deliveries; i += 1) {
  const base = fixture.event.intent;
  const input: SendIntentInput = {
    ...base,
    createdBy: { worker: config.worker, task: config.task },
    message: config.regenerateDraft ? { ...base.message, body: `${base.message.body}\n\nRegenerated draft by ${config.worker}.` } : base.message,
  };
  const created = await store.create(input);
  intentId = created.record.intentId;
  const outcome = await dispatcher.dispatch(intentId);
  deliveries.push({
    delivery: i,
    eventId: fixture.event.id,
    intentId,
    created: created.created,
    sameContent: created.sameContent,
    outcome: outcome.kind,
    submitted: outcome.submitted,
    reason: outcome.reason ?? null,
    late: outcome.late ?? false,
  });
}
const record = await settle(intentId);
out(`result:${JSON.stringify({ worker: config.worker, task: config.task, pid: process.pid, deliveries, record: sendRecordSnapshot(record) })}`);
process.exit(0);

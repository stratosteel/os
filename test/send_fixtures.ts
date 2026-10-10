/**
 * Shared fixtures and evidence helpers for the send record tests (A05, A09). Invented names, example.com addresses and
 * made-up hashes only. Evidence (input fixture, event and attempt trace, transport calls, Sent queries, process trace)
 * is written under the test's temporary directory, or under $OS_EVIDENCE_DIR when it is set, and every path is printed
 * as a test diagnostic.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DispatchPoint } from '../src/send_dispatcher.js';
import { SendRecordStore, policyVersionOf, sendRecordSnapshot, type SendIntentInput, type SendIntentKey } from '../src/send_record.js';
import { FakeTransport } from '../src/transport.js';
import { CONFIG, EVIDENCED, SPEC } from './policy_fixtures.js';

export const KEY: SendIntentKey = { tenant: 'tenant-template', packageId: 'ACME-PKG-0001', supplierId: 'supplier-a', inquiryRevision: '1', step: 'initial' };

/** An L2 supplier inquiry as the worker rendered it: the evidenced message of the policy fixtures. */
export function intentInput(overrides: Partial<SendIntentInput> = {}): SendIntentInput {
  return {
    key: KEY,
    message: {
      from: EVIDENCED.from!,
      to: EVIDENCED.to!,
      cc: [],
      bcc: [{ address: 'archive@example.com' }],
      subject: EVIDENCED.subject!,
      body: EVIDENCED.text!,
      attachments: [SPEC],
    },
    templateId: EVIDENCED.templateId!,
    templateVersion: EVIDENCED.templateVersion!,
    policyVersion: policyVersionOf(CONFIG),
    authorization: { kind: 'policy_allow', decidedAt: '2026-10-10T08:00:00.000Z', reasons: ['L2 allow on verified evidence'] },
    action: { category: 'supplier_inquiry', level: 'L2', supervisor: EVIDENCED.supervisor, disclosureRendered: true },
    createdBy: { worker: 'worker-a', task: 'task-a-1' },
    ...overrides,
  };
}

export interface Workspace {
  root: string;
  storeDir: string;
  transportDir: string;
  evidenceDir: string;
}

/** Fresh store and transport directories; evidence under $OS_EVIDENCE_DIR/<case> or <tmp>/evidence. */
export async function workspace(caseName: string): Promise<Workspace> {
  const root = await mkdtemp(path.join(tmpdir(), `os-send-${caseName}-`));
  const base = process.env.OS_EVIDENCE_DIR;
  const evidenceDir = base ? path.join(path.resolve(base), `${caseName}-${path.basename(root)}`) : path.join(root, 'evidence');
  await mkdir(evidenceDir, { recursive: true });
  return { root, storeDir: path.join(root, 'store'), transportDir: path.join(root, 'transport'), evidenceDir };
}

export async function initStore(ws: Workspace): Promise<SendRecordStore> {
  return SendRecordStore.init(ws.storeDir);
}

/** A process trace: what the parent did and saw, with times. */
export class Trace {
  readonly lines: string[] = [];
  note(step: string): void {
    this.lines.push(`${new Date().toISOString()} ${step}`);
  }
}

/** The worker runner, compiled next to this file: dist/test/fixtures/send_worker.js. */
export const RUNNER = fileURLToPath(new URL('./fixtures/send_worker.js', import.meta.url));

export interface WorkerConfig {
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
  regenerateDraft?: boolean;
  settleTimeoutMs?: number;
}

export interface Delivery {
  delivery: number;
  eventId: string;
  intentId: string;
  created: boolean;
  sameContent: boolean;
  outcome: string;
  submitted: number;
  reason: string | null;
  late: boolean;
}

export interface WorkerResult {
  worker: string;
  task: string;
  pid: number;
  deliveries: Delivery[];
  record: ReturnType<typeof sendRecordSnapshot>;
}

export interface WorkerHandle {
  name: string;
  child: ChildProcessWithoutNullStreams;
  /** Resolves with the first stdout line that starts with the prefix. */
  line(prefix: string, timeoutMs?: number): Promise<string>;
  result(timeoutMs?: number): Promise<WorkerResult>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): void;
  resume(): void;
}

/** Start one independent worker process (node dist/test/fixtures/send_worker.js) on the workspace's store and transport. */
export async function startWorker(ws: Workspace, trace: Trace, config: WorkerConfig): Promise<WorkerHandle> {
  const configPath = path.join(ws.root, `worker-${config.worker}-${randomUUID()}.json`);
  await writeFile(configPath, JSON.stringify({ storeDir: ws.storeDir, transportDir: ws.transportDir, ...config }, null, 2) + '\n', 'utf8');
  const child = spawn(process.execPath, [RUNNER, configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  trace.note(`spawn ${config.worker} pid ${child.pid} (${RUNNER} ${configPath})`);
  const lines: string[] = [];
  let pending = '';
  let stderr = '';
  const waiters: { prefix: string; resolve: (line: string) => void }[] = [];
  const offer = (line: string) => {
    lines.push(line);
    for (const w of [...waiters]) {
      if (line.startsWith(w.prefix)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(line);
      }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i);
      pending = pending.slice(i + 1);
      if (!line.startsWith('result:')) trace.note(`${config.worker} says ${line}`);
      offer(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      trace.note(`${config.worker} pid ${child.pid} exited code ${code} signal ${signal}`);
      resolve({ code, signal });
    });
  });
  const line = (prefix: string, timeoutMs = 20_000) =>
    new Promise<string>((resolve, reject) => {
      const seen = lines.find((l) => l.startsWith(prefix));
      if (seen) return resolve(seen);
      const timer = setTimeout(() => reject(new Error(`${config.worker} did not print "${prefix}" within ${timeoutMs} ms; stderr: ${stderr}`)), timeoutMs);
      timer.unref();
      waiters.push({ prefix, resolve: (l) => (clearTimeout(timer), resolve(l)) });
      void exit.then(({ code, signal }) => {
        if (!lines.some((l) => l.startsWith(prefix))) reject(new Error(`${config.worker} exited (code ${code}, signal ${signal}) before "${prefix}"; stderr: ${stderr}`));
      });
    });
  return {
    name: config.worker,
    child,
    line,
    result: async (timeoutMs) => JSON.parse((await line('result:', timeoutMs)).slice('result:'.length)) as WorkerResult,
    exit,
    stop: () => {
      child.kill('SIGSTOP');
      trace.note(`SIGSTOP ${config.worker} pid ${child.pid}`);
    },
    resume: () => {
      child.kill('SIGCONT');
      trace.note(`SIGCONT ${config.worker} pid ${child.pid}`);
    },
  };
}

/** Write the input event fixture the worker processes read. */
export async function writeEventFixture(ws: Workspace, event: { id: string; type: string; intent: SendIntentInput }): Promise<{ path: string; fixture: unknown }> {
  const fixture = { event };
  const file = path.join(ws.evidenceDir, 'input_fixture.json');
  await writeFile(file, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  return { path: file, fixture };
}

/**
 * Persist the evidence of one case: input fixture, intent, event and attempt trace, transport calls with the count,
 * Sent queries, process trace and a summary. Prints every path as a diagnostic of the test.
 */
export async function persistEvidence(
  t: TestContext,
  ws: Workspace,
  args: { fixture?: unknown; intentIds?: string[]; trace?: Trace; summary?: Record<string, unknown> },
): Promise<string> {
  const dir = ws.evidenceDir;
  const written: string[] = [];
  const write = async (name: string, content: string) => {
    const file = path.join(dir, name);
    await writeFile(file, content, 'utf8');
    written.push(file);
  };
  if (args.fixture !== undefined) await write('input_fixture.json', JSON.stringify(args.fixture, null, 2) + '\n');
  const store = new SendRecordStore(ws.storeDir);
  const snapshots: unknown[] = [];
  for (const id of args.intentIds ?? []) {
    const record = await store.read(id).catch(() => undefined);
    for (const name of ['intent.json', 'events.jsonl']) {
      const target = path.join(dir, `${id}.${name}`);
      try {
        await copyFile(path.join(store.dirOf(id), name), target);
        written.push(target);
      } catch {
        // a missing file is part of the evidence: it is simply not listed
      }
    }
    if (record) snapshots.push(sendRecordSnapshot(record));
  }
  const transport = new FakeTransport(ws.transportDir);
  const calls = await transport.calls().catch(() => []);
  const sent = await transport.sentItems().catch(() => []);
  const queries = await transport.queries().catch(() => []);
  await write('transport_calls.json', JSON.stringify({ count: calls.length, calls }, null, 2) + '\n');
  await write('transport_sent_items.json', JSON.stringify({ count: sent.length, sent }, null, 2) + '\n');
  await write('transport_sent_queries.json', JSON.stringify({ count: queries.length, queries }, null, 2) + '\n');
  if (args.trace) await write('process_trace.txt', args.trace.lines.join('\n') + '\n');
  await write('summary.json', JSON.stringify({ transportCalls: calls.length, sentItems: sent.length, sentQueries: queries.length, records: snapshots, ...(args.summary ?? {}) }, null, 2) + '\n');
  t.diagnostic(`evidence directory: ${dir}`);
  for (const f of written) t.diagnostic(`evidence: ${f}`);
  return dir;
}

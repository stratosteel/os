/**
 * Layer 6, human gates: the approval queue.
 * A worker that receives "ask" from the policy files a request here and stops. A person decides once.
 * Storage: append-only JSONL (one event per line: request or decision); state is rebuilt from events.
 * Every write happens under a lock file created exclusively ('wx') next to the JSONL, so a decision is an atomic
 * one-decision transition across queue instances and processes on one host: exactly one decision is persisted and the
 * loser gets "already approved" or "already rejected". A lock older than the stale timeout was left by a crashed writer
 * and is broken. Storage errors are explicit: an unreadable store is never presented as an empty queue.
 * Durable crash recovery, an authenticated scoped approver and revision-bound approvals remain gate G3 work.
 */
import { appendFile, link, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

export interface ApprovalRequest {
  id: string;
  createdAt: string;
  requestedBy: string;          // worker or agent id
  category: string;             // policy ActionCategory
  summary: string;              // one line a person reads
  payload: Record<string, unknown>;
  reasons: string[];            // why the policy said ask
  /** Tenant of the request, set by the server from its configuration. */
  tenant?: string;
  /** Job the request belongs to, for scoped reads and the approver's job scope. */
  jobId?: string;
  /** Amount the decision commits, for the approver's ceiling. */
  amount?: number;
  /** Binding of a send approval, computed by the server from trusted state; never worker-supplied. */
  binding?: unknown;
  /** SHA-256 of the canonical binding; a decision must name it. */
  bindingHash?: string;
}

export interface ApprovalDecision {
  id: string;
  decidedAt: string;
  decidedBy: string;            // a named person
  decision: 'approved' | 'rejected';
  note?: string;
  /** Configured approver whose signed token authenticated this decision. */
  approverId?: string;
  /** Binding hash the approver decided on; equals the request's bindingHash. */
  bindingHash?: string;
}

export interface ApprovalRevocation {
  id: string;
  revokedAt: string;
  revokedBy: string;
  approverId?: string;
  note?: string;
}

type Event =
  | { type: 'request'; data: ApprovalRequest }
  | { type: 'decision'; data: ApprovalDecision }
  | { type: 'revocation'; data: ApprovalRevocation };

export interface ApprovalView extends ApprovalRequest {
  status: ApprovalStatus;
  decision?: ApprovalDecision;
  revocation?: ApprovalRevocation;
}

export interface ApprovalQueueOptions {
  /** How long a write waits for the store lock before it fails with an explicit error, in milliseconds (default 10 000). */
  lockTimeoutMs?: number;
  /** A lock older than this was left by a crashed writer and is broken, in milliseconds (default 30 000). */
  staleLockMs?: number;
}

const errorCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isEvent(value: unknown): value is Event {
  const ev = value as Partial<Event> | null;
  return !!ev && (ev.type === 'request' || ev.type === 'decision' || ev.type === 'revocation') && typeof ev.data?.id === 'string';
}

function lockToken(content: string): unknown {
  try {
    return (JSON.parse(content) as { token?: unknown }).token;
  } catch {
    return undefined;
  }
}

function sameDecision(a: ApprovalDecision, b: ApprovalDecision): boolean {
  return a.id === b.id && a.decidedAt === b.decidedAt && a.decidedBy === b.decidedBy && a.decision === b.decision && (a.note ?? null) === (b.note ?? null);
}

/**
 * State rebuilt from the events: the first decision on a request is the decision, a later one is never applied; the
 * first revocation of an approved request makes it revoked.
 */
function rebuild(events: Event[]): Map<string, ApprovalView> {
  const byId = new Map<string, ApprovalView>();
  for (const ev of events) {
    if (ev.type === 'request') byId.set(ev.data.id, { ...ev.data, status: 'pending' });
    else if (ev.type === 'decision') {
      const v = byId.get(ev.data.id);
      if (v && v.status === 'pending') {
        v.status = ev.data.decision;
        v.decision = ev.data;
      }
    } else {
      const v = byId.get(ev.data.id);
      if (v && v.status === 'approved') {
        v.status = 'revoked';
        v.revocation = ev.data;
      }
    }
  }
  return byId;
}

export class ApprovalQueue {
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(private readonly path: string, private readonly now: () => Date = () => new Date(), options: ApprovalQueueOptions = {}) {
    this.lockPath = `${path}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
  }

  /** The raw store, or null while it does not exist. Any other read error is explicit. */
  private async readStore(): Promise<string | null> {
    try {
      return await readFile(this.path, 'utf8');
    } catch (e) {
      if (errorCode(e) === 'ENOENT') return null;
      throw new Error(`approval store ${this.path} cannot be read: ${errorText(e)}`, { cause: e });
    }
  }

  /** A line is an event once its newline is written; the segment after the last newline is an append still in progress. */
  private parse(text: string | null): Event[] {
    if (text === null) return [];
    const lines = text.split('\n');
    lines.pop();
    const events: Event[] = [];
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        ev = undefined;
      }
      if (!isEvent(ev)) throw new Error(`approval store ${this.path} line ${i + 1} is not a valid approval event`);
      events.push(ev);
    });
    return events;
  }

  private async events(): Promise<Event[]> {
    return this.parse(await this.readStore());
  }

  /** Append one event. The caller holds the lock and passes the store text it read under that lock. */
  private async appendLocked(current: string | null, ev: Event): Promise<void> {
    if (current && !current.endsWith('\n')) {
      throw new Error(`approval store ${this.path} ends with an interrupted write; repair its last line before writing`);
    }
    await appendFile(this.path, JSON.stringify(ev) + '\n', 'utf8');
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      if (await this.tryLock(token)) break;
      if (await this.breakStaleLock()) continue;
      if (Date.now() >= deadline) throw new Error(`approval store ${this.path} is locked by another writer (${this.lockPath}); try again`);
      await pause(5 + Math.floor(Math.random() * 20));
    }
    let result: T;
    try {
      result = await work();
    } catch (e) {
      await this.unlock(token).catch(() => undefined);
      throw e;
    }
    await this.unlock(token);
    return result;
  }

  private async tryLock(token: string): Promise<boolean> {
    let handle;
    try {
      handle = await open(this.lockPath, 'wx');
    } catch (e) {
      if (errorCode(e) === 'EEXIST') return false;
      throw new Error(`approval store lock ${this.lockPath} cannot be created: ${errorText(e)}`, { cause: e });
    }
    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid }), 'utf8');
      await handle.close();
    } catch (e) {
      await handle.close().catch(() => undefined);
      await unlink(this.lockPath).catch(() => undefined);
      throw new Error(`approval store lock ${this.lockPath} cannot be written: ${errorText(e)}`, { cause: e });
    }
    return true;
  }

  /** Remove the lock if it is still ours; a lock broken as stale and taken by another writer is left alone. */
  private async unlock(token: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.lockPath, 'utf8');
    } catch (e) {
      if (errorCode(e) === 'ENOENT') return;
      throw new Error(`approval store lock ${this.lockPath} cannot be read: ${errorText(e)}`, { cause: e });
    }
    if (lockToken(content) === token) await unlink(this.lockPath);
  }

  /**
   * Break a lock older than the stale timeout. The lock is moved aside first and checked to be the very file judged
   * stale, so a waiter never removes a lock another writer has just taken. True means: try to lock again now.
   */
  private async breakStaleLock(): Promise<boolean> {
    let seen;
    try {
      seen = await stat(this.lockPath);
    } catch (e) {
      if (errorCode(e) === 'ENOENT') return true;
      throw new Error(`approval store lock ${this.lockPath} cannot be read: ${errorText(e)}`, { cause: e });
    }
    if (Date.now() - seen.mtimeMs < this.staleLockMs) return false;
    const aside = `${this.lockPath}.stale-${randomUUID()}`;
    try {
      await rename(this.lockPath, aside);
    } catch (e) {
      if (errorCode(e) === 'ENOENT') return true;
      throw new Error(`approval store lock ${this.lockPath} cannot be broken: ${errorText(e)}`, { cause: e });
    }
    const moved = await stat(aside);
    if (moved.ino === seen.ino && moved.mtimeMs === seen.mtimeMs) {
      await unlink(aside);
      return true;
    }
    // Another writer took the lock between the check and the move: put its lock back.
    try {
      await link(aside, this.lockPath);
    } catch (e) {
      await unlink(aside).catch(() => undefined);
      throw new Error(`approval store lock ${this.lockPath} changed hands while a stale lock was broken; try again`, { cause: e });
    }
    await unlink(aside);
    return false;
  }

  async request(input: Omit<ApprovalRequest, 'id' | 'createdAt'>): Promise<ApprovalRequest> {
    if (!input.summary.trim()) throw new Error('summary is required');
    const req: ApprovalRequest = { id: randomUUID(), createdAt: this.now().toISOString(), ...input };
    await this.withLock(async () => this.appendLocked(await this.readStore(), { type: 'request', data: req }));
    return req;
  }

  async list(status?: ApprovalStatus): Promise<ApprovalView[]> {
    const all = [...rebuild(await this.events()).values()];
    return status ? all.filter((v) => v.status === status) : all;
  }

  async get(id: string): Promise<ApprovalView | undefined> {
    return rebuild(await this.events()).get(id);
  }

  /**
   * Run `work` with the queue's state while holding the store lock, so no decision or revocation is recorded meanwhile.
   * The dispatch gate reads an approval this way and takes the document registry's fence inside it (lock order: this
   * queue, then the registry; nothing takes them the other way round). `work` must not write to this queue.
   */
  async readLocked<T>(work: (state: ReadonlyMap<string, ApprovalView>) => Promise<T>): Promise<T> {
    return this.withLock(async () => work(rebuild(this.parse(await this.readStore()))));
  }

  /**
   * One decision per request, as an atomic transition: the state is read and the decision appended under the store
   * lock. Of two racing deciders exactly one succeeds; the other gets "already approved" or "already rejected".
   */
  async decide(id: string, decision: 'approved' | 'rejected', decidedBy: string, note?: string, authenticated: { approverId?: string; bindingHash?: string } = {}): Promise<ApprovalView> {
    if (!decidedBy.trim()) throw new Error('decidedBy must name a person');
    return this.withLock(async () => {
      const text = await this.readStore();
      const current = rebuild(this.parse(text)).get(id);
      if (!current) throw new Error(`unknown approval ${id}`);
      if (current.status !== 'pending') throw new Error(`approval ${id} already ${current.status}`);
      if (current.bindingHash !== undefined && authenticated.bindingHash !== current.bindingHash) {
        throw new Error(`approval ${id} binds ${current.bindingHash}; the decision names ${authenticated.bindingHash ?? 'no binding'}`);
      }
      const d: ApprovalDecision = {
        id, decidedAt: this.now().toISOString(), decidedBy, decision, note,
        ...(authenticated.approverId ? { approverId: authenticated.approverId } : {}),
        ...(current.bindingHash !== undefined ? { bindingHash: current.bindingHash } : {}),
      };
      await this.appendLocked(text, { type: 'decision', data: d });
      // Defense in depth: the decision on record must be this one; if the lock was ever defeated, the loser still fails.
      const recorded = rebuild(await this.events()).get(id);
      if (!recorded?.decision || !sameDecision(recorded.decision, d)) throw new Error(`approval ${id} already ${recorded?.status ?? 'decided'}`);
      return { ...current, status: decision, decision: d };
    });
  }

  /** Revoke an approved request, once, under the store lock. A pending request is rejected instead. */
  async revoke(id: string, revokedBy: string, note?: string, authenticated: { approverId?: string } = {}): Promise<ApprovalView> {
    if (!revokedBy.trim()) throw new Error('revokedBy must name a person');
    return this.withLock(async () => {
      const text = await this.readStore();
      const current = rebuild(this.parse(text)).get(id);
      if (!current) throw new Error(`unknown approval ${id}`);
      if (current.status !== 'approved') throw new Error(`approval ${id} is ${current.status}: only an approved request can be revoked`);
      const r: ApprovalRevocation = { id, revokedAt: this.now().toISOString(), revokedBy, ...(note ? { note } : {}), ...(authenticated.approverId ? { approverId: authenticated.approverId } : {}) };
      await this.appendLocked(text, { type: 'revocation', data: r });
      const recorded = rebuild(await this.events()).get(id);
      if (recorded?.status !== 'revoked' || recorded.revocation?.revokedAt !== r.revokedAt || recorded.revocation.revokedBy !== revokedBy) {
        throw new Error(`approval ${id} revocation was not recorded`);
      }
      return recorded;
    });
  }
}

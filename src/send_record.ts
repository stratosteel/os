/**
 * Layer 3, worker runtime: the send record. One business send intent per (tenant, inquiry or package, supplier, inquiry
 * revision, action or follow-up step), persisted before anything is sent, with one durable append-only attempt history.
 *
 * Contract (ASTRA, ledger 2026-10-07 00:35, G3-A05 and G3-A09; requirements sections 5, 6 and 7):
 *  - The key is exactly those five fields. A changed worker id, task id or a regenerated draft finds the existing intent
 *    and is recorded as a suppressed duplicate; a distinct follow-up step or a new inquiry revision is a new intent.
 *  - The intent (rendered message, attachment manifest, template, policy version, authorization, correlation id,
 *    idempotency key, limits) is written once, atomically, and re-verified against its content hash on every read.
 *  - Every transition is an event in `events.jsonl`, appended under the intent's lock file and flushed to the device.
 *    The state is rebuilt by `reduceSendRecord`, a pure function of the intent and the events. The reducer is the
 *    correctness argument, not the lock: a claim carries a fence (one more than the last valid claim) and a lease; a
 *    submission is valid only under the current fence with a live lease and with no earlier attempt unresolved; events
 *    that break these rules are void. A writer re-reads after appending and acts only if its own event is valid, so a
 *    lock broken under a stopped worker still cannot yield two submissions.
 *  - States are separate: approved, queued, accepted, observed_sent, failed, unknown_reconciling. "Accepted" is the
 *    provider's acceptance only (Graph sendMail: 202 with no body); "observed_sent" needs the provider's Sent evidence;
 *    there is no delivered state. A takeover that finds a started attempt without a result enters unknown_reconciling and
 *    never submits again without evidence of non-acceptance (or a provider deduplication proven for the endpoint).
 *
 * Storage: `<root>/intents/<intentId>/{intent.json,events.jsonl,lock}` on a local POSIX filesystem. A missing root is an
 * unavailable store, never an empty one.
 */
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ActionCategory, AttachmentEvidence, AutonomyLevel, DrawingCheckEvidence, MessageAddress, PolicyConfig } from './policy.js';
import { appendDurable, createExclusive, errorCode, errorText, withFileLock, type FileLockOptions } from './file_lock.js';
import { canonicalJson, messageContentHash, normalizeMessage, sha256Hex, type NormalizedMessage, type RenderedMessage } from './message.js';
import type { SentEvidence } from './transport.js';

/** The business key of one intended send. Nothing else (worker, task, draft text) is part of it. */
export interface SendIntentKey {
  tenant: string;
  /** Inquiry (RFQ_OUT) or work package the message belongs to. */
  packageId: string;
  supplierId: string;
  /** Revision of the inquiry in the system of record; an authorized new revision is a new intent. */
  inquiryRevision: string;
  /** Action or follow-up step, for example 'initial' or 'followup-1'; a distinct step is a new intent. */
  step: string;
}

const KEY_FIELDS = ['tenant', 'packageId', 'supplierId', 'inquiryRevision', 'step'] as const;

/** The five key fields, trimmed; any other field a caller passes is dropped. */
export function normalizeIntentKey(key: SendIntentKey): SendIntentKey {
  const out = {} as SendIntentKey;
  for (const field of KEY_FIELDS) {
    const value = (key as unknown as Record<string, unknown> | undefined)?.[field];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`send intent key needs a non-empty ${field}`);
    out[field] = value.trim();
  }
  return out;
}

/** Deterministic id of the intent: a hash of the canonical key. */
export function intentIdOf(key: SendIntentKey): string {
  return `si-${sha256Hex(canonicalJson(normalizeIntentKey(key))).slice(0, 32)}`;
}

/** Version of a policy configuration: a hash over its canonical form, so any rule change is a new version. */
export function policyVersionOf(config: PolicyConfig): string {
  return `policy-sha256:${sha256Hex(canonicalJson(config))}`;
}

/** Policy-relevant facts of the send, kept for the dispatch-time recheck. */
export interface SendAction {
  category: ActionCategory;
  level: AutonomyLevel;
  supervisor?: string;
  drawingChecks?: DrawingCheckEvidence[];
  disclosureRendered?: boolean;
}

/** Why the send may happen: the policy allowed it (L2), or a person approved it (approval id). */
export type SendAuthorization = { kind: 'policy_allow'; decidedAt: string; reasons?: string[] } | { kind: 'approval'; approvalId: string };

export interface SendLimits {
  /** Attempts in total; a new attempt needs every earlier one proven not accepted. */
  maxAttempts: number;
  /** Automatic Sent queries for an ambiguous outcome before it is escalated to a person. */
  maxReconcileQueries: number;
}

export const DEFAULT_SEND_LIMITS: SendLimits = { maxAttempts: 3, maxReconcileQueries: 5 };

export interface SendIntentInput {
  key: SendIntentKey;
  message: RenderedMessage;
  templateId: string;
  templateVersion: string;
  policyVersion: string;
  authorization: SendAuthorization;
  action: SendAction;
  /** Who created it, for the audit trail only; never part of the key. */
  createdBy: { worker: string; task: string };
  limits?: Partial<SendLimits>;
}

export interface SendIntent {
  schema: 'stratosteel-os/send-intent/v1';
  intentId: string;
  key: SendIntentKey;
  /** Carried in the outgoing message so the provider's Sent evidence can be matched after a restart. */
  correlationId: string;
  /** The same on every attempt; it deduplicates only on a transport whose deduplication is proven. */
  idempotencyKey: string;
  /** SHA-256 of the canonical rendered message (message.ts). Immutable. */
  contentHash: string;
  message: NormalizedMessage;
  templateId: string;
  templateVersion: string;
  policyVersion: string;
  authorization: SendAuthorization;
  action: SendAction;
  limits: SendLimits;
  createdAt: string;
  createdBy: { worker: string; task: string };
}

export type SendState = 'approved' | 'queued' | 'accepted' | 'observed_sent' | 'failed' | 'unknown_reconciling';
export const SEND_STATES: readonly SendState[] = ['approved', 'queued', 'accepted', 'observed_sent', 'failed', 'unknown_reconciling'];

export type SubmitOutcome = 'accepted' | 'not_accepted' | 'unknown' | 'not_submitted';

export type SendEventBody =
  | { type: 'claimed'; fence: number; leaseUntil: string }
  | { type: 'renewed'; fence: number; leaseUntil: string }
  | { type: 'released'; fence: number }
  | { type: 'submit_started'; fence: number; attempt: number; contentHash: string; idempotencyKey: string; dedupProof?: string }
  | { type: 'submit_result'; fence: number; attempt: number; outcome: SubmitOutcome; status?: number; transportMessageId?: string; deduplicated?: boolean; error?: string }
  | { type: 'reconcile_query'; fence: number; query: number; found: SentEvidence[]; error?: string }
  | { type: 'escalated'; fence: number; reason: string; approvalId?: string }
  | { type: 'dispatch_blocked'; fence: number; reasons: string[] }
  | { type: 'duplicate_suppressed'; task: string; contentHash: string; sameContent: boolean }
  | { type: 'stale_rejected'; fence: number; attempted: string; reason: string };

export interface SendEventMeta {
  id: string;
  /** Store clock (UTC) when the event was appended. */
  at: string;
  worker: string;
  pid: number;
}

export type SendEvent = SendEventMeta & SendEventBody;

export interface AttemptView {
  attempt: number;
  fence: number;
  worker: string;
  pid: number;
  startedAt: string;
  dedupProof?: string;
  result?: { outcome: SubmitOutcome; at: string; status?: number; transportMessageId?: string; deduplicated?: boolean; error?: string; late: boolean };
}

export interface SendRecord {
  intentId: string;
  intent: SendIntent;
  state: SendState;
  /** First time each state was entered (UTC). */
  stateTimes: Partial<Record<SendState, string>>;
  /** Every state change, in order. */
  transitions: { state: SendState; at: string; event?: string }[];
  /** Fence of the last valid claim (0: never claimed). */
  fence: number;
  lease: { fence: number; holder: string; pid: number; since: string; until: string; released: boolean } | null;
  attempts: AttemptView[];
  /** Valid Sent queries recorded for this intent. */
  reconcileQueries: number;
  /** Provider id: from the acceptance when the endpoint returns one, otherwise from the Sent evidence. */
  transportMessageId?: string;
  sentEvidence?: SentEvidence;
  /** Sent evidence with this correlation id but a different content hash. */
  contentMismatch?: SentEvidence;
  escalations: { at: string; worker: string; reason: string; approvalId?: string }[];
  blocks: { at: string; worker: string; reasons: string[] }[];
  suppressed: { at: string; worker: string; task: string; contentHash: string; sameContent: boolean }[];
  staleRejections: { at: string; worker: string; fence: number; attempted: string; reason: string }[];
  /** Why the intent cannot progress without a person, if it cannot. */
  blocked?: string;
  events: SendEvent[];
  /** Events the reducer refused, with the reason. */
  voided: { id: string; type: string; reason: string }[];
}

const ms = (iso: string) => Date.parse(iso);

/**
 * The state of a send intent, rebuilt from its events. Pure and deterministic: the same intent and events give the same
 * record in every process. Lease checks use the events' own timestamps.
 */
export function reduceSendRecord(intent: SendIntent, events: SendEvent[]): SendRecord {
  const rec: SendRecord = {
    intentId: intent.intentId,
    intent,
    state: 'approved',
    stateTimes: { approved: intent.createdAt },
    transitions: [{ state: 'approved', at: intent.createdAt }],
    fence: 0,
    lease: null,
    attempts: [],
    reconcileQueries: 0,
    escalations: [],
    blocks: [],
    suppressed: [],
    staleRejections: [],
    events,
    voided: [],
  };
  const enter = (state: SendState, ev: SendEvent) => {
    if (rec.state === state) return;
    rec.state = state;
    rec.transitions.push({ state, at: ev.at, event: ev.id });
    rec.stateTimes[state] ??= ev.at;
  };
  const leaseActiveAt = (at: string) => rec.lease !== null && !rec.lease.released && ms(at) < ms(rec.lease.until);
  const unresolved = () => (rec.sentEvidence ? [] : rec.attempts.filter((a) => !a.result || a.result.outcome === 'unknown'));
  const accepted = () => rec.attempts.some((a) => a.result?.outcome === 'accepted');
  const retryable = () => rec.attempts.length < intent.limits.maxAttempts;
  const settle = (ev: SendEvent) => {
    if (rec.sentEvidence) return enter('observed_sent', ev);
    if (accepted()) return enter('accepted', ev);
    if (unresolved().some((a) => a.result?.outcome === 'unknown')) return enter('unknown_reconciling', ev);
    if (unresolved().length) return;
    const last = rec.attempts[rec.attempts.length - 1];
    if (last?.result?.outcome === 'not_accepted') return enter('failed', ev);
    if (last?.result?.outcome === 'not_submitted') return enter('queued', ev);
  };

  const apply = (ev: SendEvent): string | null => {
    switch (ev.type) {
      case 'claimed': {
        if (ev.fence !== rec.fence + 1) return `claim fence ${ev.fence} is not the next fence ${rec.fence + 1}`;
        if (rec.state === 'observed_sent') return 'observed in Sent: nothing left to claim';
        if (leaseActiveAt(ev.at)) return `lease held by ${rec.lease!.holder} (fence ${rec.lease!.fence}) until ${rec.lease!.until}`;
        if (!(ms(ev.leaseUntil) > ms(ev.at))) return 'a lease must end after it starts';
        rec.fence = ev.fence;
        rec.lease = { fence: ev.fence, holder: ev.worker, pid: ev.pid, since: ev.at, until: ev.leaseUntil, released: false };
        // A takeover that finds a started attempt without a result cannot know whether the provider accepted it.
        if (unresolved().some((a) => !a.result)) enter('unknown_reconciling', ev);
        else if (rec.state === 'approved' || (rec.state === 'failed' && retryable())) enter('queued', ev);
        return null;
      }
      case 'renewed': {
        if (!rec.lease || ev.fence !== rec.fence) return `renewal under fence ${ev.fence}, the current fence is ${rec.fence}`;
        if (!leaseActiveAt(ev.at)) return 'the lease expired or was released before the renewal';
        if (!(ms(ev.leaseUntil) > ms(ev.at))) return 'a lease must end after it starts';
        rec.lease.until = ev.leaseUntil;
        return null;
      }
      case 'released': {
        if (!rec.lease || ev.fence !== rec.fence || rec.lease.released) return `release under fence ${ev.fence} of a lease that is not held`;
        rec.lease.released = true;
        return null;
      }
      case 'submit_started': {
        if (ev.fence !== rec.fence) return `stale fence ${ev.fence}: the current fence is ${rec.fence}`;
        if (!leaseActiveAt(ev.at)) return 'the lease expired or was released before the submission started';
        if (rec.state === 'accepted' || rec.state === 'observed_sent') return `already ${rec.state}: a second submission is never started`;
        if (rec.contentMismatch) return 'blocked: Sent evidence with this correlation id has different content';
        const open = unresolved();
        if (open.length && !ev.dedupProof) return `attempt ${open[0].attempt} is unresolved: reconcile before any retry`;
        if (rec.attempts.length >= intent.limits.maxAttempts) return `attempts exhausted (${intent.limits.maxAttempts})`;
        if (ev.attempt !== rec.attempts.length + 1) return `attempt number ${ev.attempt} is not ${rec.attempts.length + 1}`;
        if (ev.contentHash !== intent.contentHash) return 'content hash differs from the immutable intent';
        if (ev.idempotencyKey !== intent.idempotencyKey) return 'idempotency key differs from the intent';
        rec.attempts.push({ attempt: ev.attempt, fence: ev.fence, worker: ev.worker, pid: ev.pid, startedAt: ev.at, ...(ev.dedupProof ? { dedupProof: ev.dedupProof } : {}) });
        enter('queued', ev);
        return null;
      }
      case 'submit_result': {
        const a = rec.attempts[ev.attempt - 1];
        if (!a) return `no attempt ${ev.attempt}`;
        if (ev.fence !== a.fence) return `attempt ${ev.attempt} was started under fence ${a.fence}: only that worker reports its result`;
        if (a.result && a.result.outcome !== 'unknown') return `attempt ${ev.attempt} is already resolved as ${a.result.outcome}`;
        if (a.result && (ev.outcome === 'unknown' || ev.outcome === 'not_submitted')) return `attempt ${ev.attempt} already reported a call with an unknown outcome`;
        a.result = {
          outcome: ev.outcome,
          at: ev.at,
          ...(ev.status !== undefined ? { status: ev.status } : {}),
          ...(ev.transportMessageId ? { transportMessageId: ev.transportMessageId } : {}),
          ...(ev.deduplicated ? { deduplicated: true } : {}),
          ...(ev.error ? { error: ev.error } : {}),
          late: ev.fence !== rec.fence,
        };
        if (ev.outcome === 'accepted' && ev.transportMessageId) rec.transportMessageId ??= ev.transportMessageId;
        settle(ev);
        return null;
      }
      case 'reconcile_query': {
        if (ev.fence !== rec.fence) return `stale fence ${ev.fence}: the current fence is ${rec.fence}`;
        if (!leaseActiveAt(ev.at)) return 'the lease expired or was released before the query was recorded';
        rec.reconcileQueries += 1;
        const found = Array.isArray(ev.found) ? ev.found : [];
        const mismatch = found.find((f) => f.contentHash !== undefined && f.contentHash !== intent.contentHash);
        if (mismatch) {
          rec.contentMismatch = mismatch;
          return null;
        }
        if (found.length && !rec.sentEvidence) {
          rec.sentEvidence = found[0];
          rec.transportMessageId = found[0].messageId;
          enter('observed_sent', ev);
        }
        return null;
      }
      case 'escalated': {
        if (ev.fence !== rec.fence) return `stale fence ${ev.fence}: the current fence is ${rec.fence}`;
        rec.escalations.push({ at: ev.at, worker: ev.worker, reason: ev.reason, ...(ev.approvalId ? { approvalId: ev.approvalId } : {}) });
        return null;
      }
      case 'dispatch_blocked': {
        if (ev.fence !== rec.fence) return `stale fence ${ev.fence}: the current fence is ${rec.fence}`;
        rec.blocks.push({ at: ev.at, worker: ev.worker, reasons: ev.reasons });
        return null;
      }
      case 'duplicate_suppressed':
        rec.suppressed.push({ at: ev.at, worker: ev.worker, task: ev.task, contentHash: ev.contentHash, sameContent: ev.sameContent });
        return null;
      case 'stale_rejected':
        rec.staleRejections.push({ at: ev.at, worker: ev.worker, fence: ev.fence, attempted: ev.attempted, reason: ev.reason });
        return null;
      default:
        return `unknown event type ${(ev as { type?: unknown }).type}`;
    }
  };

  for (const ev of events) {
    const reason = apply(ev);
    if (reason) rec.voided.push({ id: ev.id, type: ev.type, reason });
  }

  if (rec.state !== 'accepted' && rec.state !== 'observed_sent') {
    if (rec.contentMismatch) rec.blocked = `Sent evidence ${rec.contentMismatch.messageId} carries this correlation id with different content`;
    else if (rec.escalations.length && unresolved().length) rec.blocked = 'ambiguous outcome escalated to a person: no new submission without evidence of non-acceptance';
    else if (rec.state === 'failed' && !retryable()) rec.blocked = `attempts exhausted (${intent.limits.maxAttempts}) with proven non-acceptance`;
  }
  return rec;
}

/** True while an attempt was started and neither its result nor Sent evidence resolves it. */
export function hasUnresolvedAttempt(record: SendRecord): boolean {
  return !record.sentEvidence && record.attempts.some((a) => !a.result || a.result.outcome === 'unknown');
}

/** A label a person can read. It never claims more than the evidence: no "sent" before Sent evidence, never "delivered". */
export function describeSendState(record: SendRecord): string {
  switch (record.state) {
    case 'approved':
      return 'approved; not queued; nothing has been submitted';
    case 'queued':
      return 'queued in the outbox; no acceptance by the provider is recorded';
    case 'accepted':
      return 'accepted by the provider (an acceptance such as 202 Accepted, not processing or delivery); not yet observed in the Sent folder';
    case 'observed_sent':
      return `observed in the provider's Sent folder as ${record.transportMessageId}; delivery to the recipients is not known`;
    case 'failed':
      return 'failed: the provider proved that it accepted nothing';
    case 'unknown_reconciling':
      return "outcome unknown: reconciling against the provider's Sent evidence; no new submission without evidence of non-acceptance";
  }
}

/** The send record as every reader must see it: the fields ASTRA's A09 contract names, plus state and history. */
export function sendRecordSnapshot(r: SendRecord) {
  const i = r.intent;
  return {
    intentId: r.intentId,
    key: i.key,
    correlationId: i.correlationId,
    idempotencyKey: i.idempotencyKey,
    contentHash: i.contentHash,
    from: i.message.from,
    to: i.message.to,
    cc: i.message.cc,
    bcc: i.message.bcc,
    subject: i.message.subject,
    attachments: i.message.attachments.map((a) => ({ documentId: a.documentId, revision: a.revision, sha256: a.sha256 })),
    templateId: i.templateId,
    templateVersion: i.templateVersion,
    policyVersion: i.policyVersion,
    approvalId: i.authorization.kind === 'approval' ? i.authorization.approvalId : null,
    state: r.state,
    label: describeSendState(r),
    stateTimes: r.stateTimes,
    transportMessageId: r.transportMessageId ?? null,
    attempts: r.attempts,
    reconcileQueries: r.reconcileQueries,
    escalations: r.escalations,
    blocked: r.blocked ?? null,
  };
}

export interface SendRecordStoreOptions {
  /** Clock that stamps events (UTC). Default: this process's clock. */
  clock?: () => Date;
  lock?: FileLockOptions;
}

export interface CreateResult {
  record: SendRecord;
  /** This call created the intent; false means it already existed and this call was recorded as a suppressed duplicate. */
  created: boolean;
  /** The caller's rendered message has the same content hash as the stored intent. */
  sameContent: boolean;
}

export interface TransactResult {
  /** An event was appended. */
  appended: boolean;
  /** The appended event is valid in the rebuilt record (false when vetoed or voided). */
  accepted: boolean;
  reason?: string;
  record: SendRecord;
  event?: SendEvent;
}

function isSendEvent(value: unknown): value is SendEvent {
  const ev = value as Partial<SendEvent> | null;
  return !!ev && typeof ev.type === 'string' && typeof ev.id === 'string' && typeof ev.at === 'string' && typeof ev.worker === 'string';
}

const filled = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function checkManifest(attachments: AttachmentEvidence[]): void {
  attachments.forEach((a, i) => {
    const missing: string[] = [];
    if (!filled(a?.documentId)) missing.push('documentId');
    if (!filled(a?.revision)) missing.push('revision');
    if (typeof a?.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(a.sha256)) missing.push('sha256');
    if (!filled(a?.filename)) missing.push('filename');
    if (a?.kind !== 'drawing' && a?.kind !== 'document') missing.push('kind');
    if (missing.length) throw new Error(`attachment ${i + 1} needs an immutable reference: ${missing.join(', ')}`);
  });
}

function addressList(list: MessageAddress[]): string {
  return list.map((a) => a.address).join(', ');
}

export class SendRecordStore {
  readonly intentsDir: string;

  constructor(readonly root: string, private readonly options: SendRecordStoreOptions = {}) {
    this.intentsDir = path.join(root, 'intents');
  }

  /** Create the store's directories. Only setup does this: a missing store directory later is an unavailable store. */
  static async init(root: string, options: SendRecordStoreOptions = {}): Promise<SendRecordStore> {
    await mkdir(path.join(root, 'intents'), { recursive: true });
    return new SendRecordStore(root, options);
  }

  now(): Date {
    return (this.options.clock ?? (() => new Date()))();
  }

  dirOf(intentId: string): string {
    if (!/^si-[0-9a-f]{32}$/.test(intentId)) throw new Error(`not a send intent id: ${intentId}`);
    return path.join(this.intentsDir, intentId);
  }

  eventsPath(intentId: string): string {
    return path.join(this.dirOf(intentId), 'events.jsonl');
  }

  intentPath(intentId: string): string {
    return path.join(this.dirOf(intentId), 'intent.json');
  }

  private lockPath(intentId: string): string {
    return path.join(this.dirOf(intentId), 'lock');
  }

  /**
   * Persist the intent for a key, or find the existing one. Two workers, a restarted worker or a regenerated draft for
   * the same key all get the same intent; every call after the first is recorded as a suppressed duplicate.
   */
  async create(input: SendIntentInput): Promise<CreateResult> {
    const key = normalizeIntentKey(input.key);
    const intentId = intentIdOf(key);
    const message = normalizeMessage(input.message);
    checkManifest(message.attachments);
    for (const [field, value] of [['templateId', input.templateId], ['templateVersion', input.templateVersion], ['policyVersion', input.policyVersion], ['createdBy.worker', input.createdBy?.worker], ['createdBy.task', input.createdBy?.task]] as const) {
      if (!filled(value)) throw new Error(`send intent needs a non-empty ${field}`);
    }
    const auth = input.authorization;
    if (!auth || (auth.kind === 'approval' ? !filled(auth.approvalId) : auth.kind !== 'policy_allow' || Number.isNaN(ms(auth.decidedAt)))) {
      throw new Error('send intent needs an authorization: a policy allow with its time, or an approval id');
    }
    if (!input.action || !filled(input.action.category) || !filled(input.action.level)) throw new Error('send intent needs the action category and level');
    const limits: SendLimits = { ...DEFAULT_SEND_LIMITS, ...(input.limits ?? {}) };
    if (!Number.isInteger(limits.maxAttempts) || limits.maxAttempts < 1 || !Number.isInteger(limits.maxReconcileQueries) || limits.maxReconcileQueries < 1) {
      throw new Error('send limits must be whole numbers of at least 1');
    }
    const contentHash = messageContentHash(message);
    const intent: SendIntent = {
      schema: 'stratosteel-os/send-intent/v1',
      intentId,
      key,
      correlationId: `corr-${intentId.slice(3)}`,
      idempotencyKey: `idem-${intentId.slice(3)}`,
      contentHash,
      message,
      templateId: input.templateId.trim(),
      templateVersion: input.templateVersion.trim(),
      policyVersion: input.policyVersion.trim(),
      authorization: auth,
      action: input.action,
      limits,
      createdAt: this.now().toISOString(),
      createdBy: { worker: input.createdBy.worker.trim(), task: input.createdBy.task.trim() },
    };
    const dir = this.dirOf(intentId);
    try {
      await mkdir(dir);
    } catch (e) {
      if (errorCode(e) === 'ENOENT') throw new Error(`send record store ${this.root} is unavailable: ${this.intentsDir} does not exist`, { cause: e });
      if (errorCode(e) !== 'EEXIST') throw new Error(`send record store ${this.root} cannot create ${dir}: ${errorText(e)}`, { cause: e });
    }
    const created = await createExclusive(this.intentPath(intentId), JSON.stringify(intent, null, 2) + '\n');
    if (created) return { record: await this.read(intentId), created: true, sameContent: true };
    const existing = await this.readIntent(intentId);
    if (canonicalJson(existing.key) !== canonicalJson(key)) throw new Error(`send intent ${intentId} holds a different key`);
    const sameContent = existing.contentHash === contentHash;
    const r = await this.transact(intentId, intent.createdBy.worker, () => ({ type: 'duplicate_suppressed', task: intent.createdBy.task, contentHash, sameContent }));
    return { record: r.record, created: false, sameContent };
  }

  /** The intent as written, verified: its id is the hash of its key and its content hash matches its message. */
  async readIntent(intentId: string): Promise<SendIntent> {
    let text: string;
    try {
      text = await readFile(this.intentPath(intentId), 'utf8');
    } catch (e) {
      if (errorCode(e) === 'ENOENT') {
        try {
          await readdir(this.intentsDir);
        } catch {
          throw new Error(`send record store ${this.root} is unavailable: ${this.intentsDir} cannot be read`, { cause: e });
        }
        throw new Error(`unknown send intent ${intentId}`, { cause: e });
      }
      throw new Error(`send intent ${intentId} cannot be read: ${errorText(e)}`, { cause: e });
    }
    let intent: SendIntent;
    try {
      intent = JSON.parse(text) as SendIntent;
    } catch (e) {
      throw new Error(`send intent ${intentId} is not valid JSON`, { cause: e });
    }
    if (intent.schema !== 'stratosteel-os/send-intent/v1' || intent.intentId !== intentId || intentIdOf(intent.key) !== intentId) {
      throw new Error(`send intent ${intentId} does not match its key`);
    }
    if (messageContentHash(intent.message) !== intent.contentHash) {
      throw new Error(`send intent ${intentId} was altered: its message no longer matches content hash ${intent.contentHash}`);
    }
    return intent;
  }

  private async readEventsText(intentId: string): Promise<string | null> {
    try {
      return await readFile(this.eventsPath(intentId), 'utf8');
    } catch (e) {
      if (errorCode(e) === 'ENOENT') return null;
      throw new Error(`send record ${intentId} cannot be read: ${errorText(e)}`, { cause: e });
    }
  }

  /** A line is an event once its newline is written; a segment after the last newline is an append still in progress. */
  private parseEvents(intentId: string, text: string | null): SendEvent[] {
    if (text === null) return [];
    const lines = text.split('\n');
    lines.pop();
    const events: SendEvent[] = [];
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        ev = undefined;
      }
      if (!isSendEvent(ev)) throw new Error(`send record ${intentId} line ${i + 1} is not a valid send event`);
      events.push(ev);
    });
    return events;
  }

  async read(intentId: string): Promise<SendRecord> {
    const intent = await this.readIntent(intentId);
    return reduceSendRecord(intent, this.parseEvents(intentId, await this.readEventsText(intentId)));
  }

  async list(): Promise<SendRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.intentsDir);
    } catch (e) {
      throw new Error(`send record store ${this.root} is unavailable: ${errorText(e)}`, { cause: e });
    }
    const records: SendRecord[] = [];
    for (const n of names.filter((x) => /^si-[0-9a-f]{32}$/.test(x)).sort()) records.push(await this.read(n));
    return records;
  }

  /**
   * Under the intent's lock: rebuild the record, let `decide` veto or produce one event from the record and the store's
   * clock reading, append it durably, rebuild again and report whether the reducer accepted the event.
   */
  async transact(intentId: string, worker: string, decide: (record: SendRecord, now: Date) => SendEventBody | { veto: string }): Promise<TransactResult> {
    return withFileLock(this.lockPath(intentId), async () => {
      const intent = await this.readIntent(intentId);
      const text = await this.readEventsText(intentId);
      if (text !== null && text.length > 0 && !text.endsWith('\n')) {
        throw new Error(`send record ${intentId} ends with an interrupted write; repair its last line before writing`);
      }
      const before = reduceSendRecord(intent, this.parseEvents(intentId, text));
      const now = this.now();
      const body = decide(before, now);
      if ('veto' in body) return { appended: false, accepted: false, reason: body.veto, record: before };
      const event = { id: randomUUID(), at: now.toISOString(), worker, pid: process.pid, ...body } as SendEvent;
      await appendDurable(this.eventsPath(intentId), JSON.stringify(event) + '\n');
      const after = await this.read(intentId);
      const voided = after.voided.find((v) => v.id === event.id);
      return { appended: true, accepted: !voided, ...(voided ? { reason: voided.reason } : {}), record: after, event };
    }, this.options.lock);
  }
}

/** One line for logs and escalations: who, what, to whom, in which state. */
export function sendRecordSummary(r: SendRecord): string {
  const m = r.intent.message;
  return `${r.intentId} ${r.intent.key.packageId}/${r.intent.key.supplierId} rev ${r.intent.key.inquiryRevision} ${r.intent.key.step}: ${m.from.address} -> ${addressList(m.to)}; ${r.state}`;
}

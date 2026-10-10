/**
 * Layer 3: the dispatcher, the only caller of SendTransport.submit() and the side-effect boundary of every send.
 *
 * One dispatch of one intent:
 *  1. Claim the intent: a 'claimed' event with the next fence and a lease. Another worker's live lease means "the loser
 *     cannot dispatch": the call returns lease_held without touching the transport.
 *  2. If an earlier attempt is unresolved (started, no result, or an unknown result), reconcile instead of submitting:
 *     query the provider's Sent evidence by correlation id, at most `maxReconcileQueries` times for the intent. Found:
 *     observed_sent. Not found: the outcome stays unknown; a timeout or an empty search never triggers a new submission.
 *     After the bound, retry only on a transport whose idempotency-key deduplication is proven for the endpoint;
 *     otherwise escalate to a person (an approval request, never a resend) and stay blocked.
 *  3. Otherwise run the dispatch-time check (policy recheck, later the approval binding): a refusal is a
 *     'dispatch_blocked' event and 0 transport calls.
 *  4. Record 'submit_started' under the current fence with a live lease, then re-read the record immediately before the
 *     call (the final fence check), then call submit() with the intent's stored message, then record 'submit_result'.
 *     A failure the transport proves happened before acceptance may be retried (a new attempt, bounded by maxAttempts);
 *     any other failure is unknown and goes to reconciliation.
 *
 * Residual window (stated, tested, not hidden): a worker stopped between its final fence check and the provider call
 * submits when it resumes, even if its lease was taken over meanwhile. The takeover never submits while that attempt is
 * unresolved, so the intent still gets at most one submission; reconciliation then records it. Closing the window needs a
 * provider-side fence or a deduplication key; Graph sendMail has neither (draft-first sending is a candidate to test).
 */
import { recheckAtDispatch, type ApprovalState, type PolicyConfig, type PolicyEvidenceVerifier, type ProposedAction } from './policy.js';
import type { ApprovalQueue } from './approvals.js';
import { errorText, pause } from './file_lock.js';
import { classifyFailure, type OutgoingMessage, type SendTransport, type SentEvidence } from './transport.js';
import { hasUnresolvedAttempt, sendRecordSummary, type SendRecord, type SendRecordStore, type SubmitOutcome } from './send_record.js';

/** Named points of a dispatch where tests inject pauses, crashes and storage faults. */
export type DispatchPoint = 'after_claim' | 'after_submit_started' | 'after_final_check' | 'after_ack' | 'after_result';

export type DispatchCheck = { ok: true } | { ok: false; reasons: string[] };

export interface DispatcherOptions {
  store: SendRecordStore;
  transport: SendTransport;
  /** Identity of this worker as it appears in the events. */
  worker: string;
  /** Lease length in milliseconds (default 30 000). */
  leaseMs?: number;
  /** Pause before a retry after a proven non-acceptance, in milliseconds (default 1 000). */
  retryBackoffMs?: number;
  /** Pause between Sent queries while reconciling, in milliseconds (default 2 000). */
  reconcileBackoffMs?: number;
  /** After an acceptance, query Sent once (default true). */
  observeAfterAccept?: boolean;
  /** Dispatch-time check at the side-effect boundary; a refusal means 0 transport calls. */
  beforeSubmit?: (record: SendRecord) => Promise<DispatchCheck> | DispatchCheck;
  /** Files the escalation for a person (an approval request) and returns its id. */
  escalate?: (record: SendRecord, reason: string) => Promise<string | undefined>;
  /** Fault-injection hook for tests. */
  onPoint?: (point: DispatchPoint, record: SendRecord) => Promise<void> | void;
}

export type DispatchKind = 'accepted' | 'observed_sent' | 'already_sent' | 'lease_held' | 'fenced' | 'blocked' | 'failed';

export interface DispatchOutcome {
  kind: DispatchKind;
  /** How many times this call invoked transport.submit(). */
  submitted: number;
  record: SendRecord;
  reason?: string;
  /** This worker's own result arrived after its fence had been superseded. */
  late?: boolean;
}

type AttemptResult = { outcome: SubmitOutcome; status?: number; transportMessageId?: string; deduplicated?: boolean; error?: string };

/** The message exactly as stored in the intent, with its correlation id. */
export function outgoingOf(record: SendRecord): OutgoingMessage {
  const m = record.intent.message;
  return {
    correlationId: record.intent.correlationId,
    from: m.from,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    body: m.body,
    attachments: m.attachments.map((a) => ({ ...a })),
  };
}

const settled = (r: SendRecord) => r.state === 'accepted' || r.state === 'observed_sent';

export class SendDispatcher {
  private readonly store: SendRecordStore;
  private readonly transport: SendTransport;
  readonly worker: string;
  private readonly leaseMs: number;
  private readonly retryBackoffMs: number;
  private readonly reconcileBackoffMs: number;
  private readonly observeAfterAccept: boolean;
  private readonly options: DispatcherOptions;

  constructor(options: DispatcherOptions) {
    if (!options.worker?.trim()) throw new Error('a dispatcher needs a worker identity');
    this.options = options;
    this.store = options.store;
    this.transport = options.transport;
    this.worker = options.worker.trim();
    this.leaseMs = options.leaseMs ?? 30_000;
    this.retryBackoffMs = options.retryBackoffMs ?? 1_000;
    this.reconcileBackoffMs = options.reconcileBackoffMs ?? 2_000;
    this.observeAfterAccept = options.observeAfterAccept ?? true;
  }

  private async point(point: DispatchPoint, record: SendRecord): Promise<void> {
    await this.options.onPoint?.(point, record);
  }

  /** Dispatch one intent: claim, reconcile or submit, record. Safe to call any number of times from any process. */
  async dispatch(intentId: string): Promise<DispatchOutcome> {
    const record = await this.store.read(intentId);
    if (settled(record)) return { kind: 'already_sent', submitted: 0, record };
    if (record.blocked) return { kind: 'blocked', submitted: 0, record, reason: record.blocked };
    const claim = await this.claim(intentId);
    if (!claim.ok) return claim.outcome;
    await this.point('after_claim', claim.record);
    try {
      return await this.run(intentId, claim.fence);
    } finally {
      await this.release(intentId, claim.fence).catch(() => undefined);
    }
  }

  /**
   * One explicit Sent query for an intent (a scheduled check or a person's request after an escalation). It never
   * submits. Returns the record after the query.
   */
  async reconcileOnce(intentId: string): Promise<SendRecord> {
    const claim = await this.claim(intentId, true);
    if (!claim.ok) return claim.outcome.record;
    try {
      await this.query(intentId, claim.fence);
      return await this.store.read(intentId);
    } finally {
      await this.release(intentId, claim.fence).catch(() => undefined);
    }
  }

  private async claim(intentId: string, forQuery = false): Promise<{ ok: true; fence: number; record: SendRecord } | { ok: false; outcome: DispatchOutcome }> {
    const result = await this.store.transact(intentId, this.worker, (r, now) => {
      if (r.state === 'observed_sent') return { veto: 'already observed in Sent' };
      if (!forQuery && r.state === 'accepted') return { veto: 'already accepted' };
      if (!forQuery && r.blocked) return { veto: r.blocked };
      if (r.lease && !r.lease.released && Date.parse(r.lease.until) > now.getTime()) {
        return { veto: `lease held by ${r.lease.holder} (fence ${r.lease.fence}) until ${r.lease.until}` };
      }
      return { type: 'claimed', fence: r.fence + 1, leaseUntil: new Date(now.getTime() + this.leaseMs).toISOString() };
    });
    if (result.accepted && result.event?.type === 'claimed') return { ok: true, fence: result.event.fence, record: result.record };
    const r = result.record;
    if (settled(r)) return { ok: false, outcome: { kind: 'already_sent', submitted: 0, record: r } };
    if (r.blocked && !forQuery) return { ok: false, outcome: { kind: 'blocked', submitted: 0, record: r, reason: r.blocked } };
    return { ok: false, outcome: { kind: 'lease_held', submitted: 0, record: r, reason: result.reason } };
  }

  private async renew(intentId: string, fence: number): Promise<boolean> {
    const r = await this.store.transact(intentId, this.worker, (rec, now) => {
      if (rec.fence !== fence || !rec.lease || rec.lease.released || Date.parse(rec.lease.until) <= now.getTime()) return { veto: `fence ${fence} no longer holds a live lease` };
      return { type: 'renewed', fence, leaseUntil: new Date(now.getTime() + this.leaseMs).toISOString() };
    });
    return r.accepted;
  }

  private async release(intentId: string, fence: number): Promise<void> {
    await this.store.transact(intentId, this.worker, (rec) => {
      if (rec.fence !== fence || !rec.lease || rec.lease.released) return { veto: 'lease not held' };
      return { type: 'released', fence };
    });
  }

  /** Record that this worker's step was refused because its fence was superseded; returns the fenced outcome. */
  private async fenced(intentId: string, fence: number, attempted: string, reason: string, submitted: number, late = false): Promise<DispatchOutcome> {
    const r = await this.store.transact(intentId, this.worker, () => ({ type: 'stale_rejected', fence, attempted, reason }));
    return { kind: 'fenced', submitted, record: r.record, reason, ...(late ? { late } : {}) };
  }

  private async escalateOnce(intentId: string, fence: number, reason: string): Promise<SendRecord> {
    let record = await this.store.read(intentId);
    if (record.escalations.some((e) => e.reason === reason)) return record;
    let approvalId: string | undefined;
    let note = reason;
    try {
      approvalId = await this.options.escalate?.(record, reason);
    } catch (e) {
      note = `${reason} (the approval request could not be filed: ${errorText(e)})`;
    }
    const r = await this.store.transact(intentId, this.worker, (rec) =>
      rec.fence === fence ? { type: 'escalated', fence, reason: note, ...(approvalId ? { approvalId } : {}) } : { veto: 'fence superseded' });
    record = r.record;
    return record;
  }

  /** One Sent query under the lease, recorded as a reconcile_query event. False when the fence was superseded. */
  private async query(intentId: string, fence: number): Promise<boolean> {
    const record = await this.store.read(intentId);
    let found: SentEvidence[] = [];
    let error: string | undefined;
    try {
      found = await this.transport.findSent(record.intent.correlationId);
    } catch (e) {
      error = errorText(e);
    }
    const r = await this.store.transact(intentId, this.worker, (rec, now) => {
      if (rec.fence !== fence || !rec.lease || rec.lease.released || Date.parse(rec.lease.until) <= now.getTime()) return { veto: `fence ${fence} no longer holds a live lease` };
      return { type: 'reconcile_query', fence, query: rec.reconcileQueries + 1, found, ...(error ? { error } : {}) };
    });
    return r.accepted;
  }

  private async submitOnce(record: SendRecord, attempt: number): Promise<AttemptResult> {
    try {
      const ack = await this.transport.submit(outgoingOf(record), { idempotencyKey: record.intent.idempotencyKey, attempt, worker: this.worker });
      return {
        outcome: 'accepted',
        status: ack.status,
        ...(ack.transportMessageId ? { transportMessageId: ack.transportMessageId } : {}),
        ...(ack.deduplicated ? { deduplicated: true } : {}),
      };
    } catch (e) {
      const c = classifyFailure(e);
      return { outcome: c.acceptance === 'not_accepted' ? 'not_accepted' : 'unknown', ...(c.status !== undefined ? { status: c.status } : {}), error: c.error };
    }
  }

  /** After an acceptance: query Sent once, so a visible message is labelled observed_sent and nothing more. */
  private async observe(intentId: string, fence: number, submitted: number): Promise<DispatchOutcome> {
    let record = await this.store.read(intentId);
    if (this.observeAfterAccept && record.state === 'accepted' && record.fence === fence) {
      await this.query(intentId, fence);
      record = await this.store.read(intentId);
    }
    return { kind: record.state === 'observed_sent' ? 'observed_sent' : 'accepted', submitted, record };
  }

  /**
   * Reconcile an unresolved attempt. Returns an outcome, 'resolved' when the attempt turned out not accepted (the retry
   * rules apply again), or 'dedup_retry' when the bound is reached and the transport's deduplication is proven.
   */
  private async reconcile(intentId: string, fence: number, submitted: number): Promise<DispatchOutcome | 'resolved' | 'dedup_retry'> {
    for (;;) {
      const record = await this.store.read(intentId);
      if (record.fence !== fence) return this.fenced(intentId, fence, 'reconcile', `fence ${fence} superseded by ${record.fence}`, submitted);
      if (record.state === 'observed_sent') return { kind: 'observed_sent', submitted, record };
      if (record.state === 'accepted') return this.observe(intentId, fence, submitted);
      if (!hasUnresolvedAttempt(record)) return 'resolved';
      if (record.contentMismatch) {
        const r = await this.escalateOnce(intentId, fence, `Sent evidence ${record.contentMismatch.messageId} has this correlation id but different content`);
        return { kind: 'blocked', submitted, record: r, reason: r.blocked };
      }
      if (record.reconcileQueries >= record.intent.limits.maxReconcileQueries) {
        const dedup = this.transport.deduplication;
        const proven = dedup.kind === 'idempotency-key' && dedup.proven === true;
        if (proven && record.attempts.length < record.intent.limits.maxAttempts && !record.attempts.some((a) => a.dedupProof)) return 'dedup_retry';
        const r = await this.escalateOnce(intentId, fence, `ambiguous outcome: no Sent evidence after ${record.reconcileQueries} queries and no proven provider deduplication; a person decides, nothing is resent`);
        return { kind: 'blocked', submitted, record: r, reason: r.blocked };
      }
      if (!(await this.renew(intentId, fence)) || !(await this.query(intentId, fence))) {
        return this.fenced(intentId, fence, 'reconcile', `fence ${fence} lost its lease while reconciling`, submitted);
      }
      const after = await this.store.read(intentId);
      if (after.state === 'observed_sent' || after.contentMismatch || after.reconcileQueries >= after.intent.limits.maxReconcileQueries) continue;
      await pause(this.reconcileBackoffMs);
    }
  }

  private async run(intentId: string, fence: number): Promise<DispatchOutcome> {
    let submitted = 0;
    let dedupRetry = false;
    for (;;) {
      let record = await this.store.read(intentId);
      if (record.fence !== fence) return this.fenced(intentId, fence, 'dispatch', `fence ${fence} superseded by ${record.fence}`, submitted);
      if (record.state === 'observed_sent') return { kind: 'observed_sent', submitted, record };
      if (record.state === 'accepted') return this.observe(intentId, fence, submitted);
      if (!dedupRetry && hasUnresolvedAttempt(record)) {
        const r = await this.reconcile(intentId, fence, submitted);
        if (r === 'resolved') continue;
        if (r === 'dedup_retry') {
          dedupRetry = true;
          continue;
        }
        return r;
      }
      if (record.blocked) {
        const r = await this.escalateOnce(intentId, fence, record.blocked);
        return { kind: r.state === 'failed' ? 'failed' : 'blocked', submitted, record: r, reason: r.blocked };
      }
      if (record.attempts.length > 0 && !dedupRetry) await pause(this.retryBackoffMs);

      const check = this.options.beforeSubmit ? await this.options.beforeSubmit(record) : ({ ok: true } as DispatchCheck);
      if (!check.ok) {
        const b = await this.store.transact(intentId, this.worker, (rec) => (rec.fence === fence ? { type: 'dispatch_blocked', fence, reasons: check.reasons } : { veto: 'fence superseded' }));
        return { kind: 'blocked', submitted, record: b.record, reason: check.reasons.join('; ') };
      }
      if (!(await this.renew(intentId, fence))) return this.fenced(intentId, fence, 'submit', `fence ${fence} lost its lease before the submission`, submitted);

      const dedupProof = dedupRetry && this.transport.deduplication.kind === 'idempotency-key' ? this.transport.deduplication.evidence : undefined;
      const started = await this.store.transact(intentId, this.worker, (rec, now) => {
        if (rec.fence !== fence || !rec.lease || rec.lease.released || Date.parse(rec.lease.until) <= now.getTime()) return { veto: `fence ${fence} no longer holds a live lease` };
        return {
          type: 'submit_started',
          fence,
          attempt: rec.attempts.length + 1,
          contentHash: rec.intent.contentHash,
          idempotencyKey: rec.intent.idempotencyKey,
          ...(dedupProof ? { dedupProof } : {}),
        };
      });
      if (!started.accepted || started.event?.type !== 'submit_started') {
        return this.fenced(intentId, fence, 'submit_started', started.reason ?? 'the submission was refused', submitted);
      }
      const attempt = started.event.attempt;
      dedupRetry = false;
      await this.point('after_submit_started', started.record);

      // Final fence check, immediately before the side effect.
      const current = await this.store.read(intentId);
      const now = this.store.now().getTime();
      if (current.fence !== fence || !current.lease || current.lease.released || Date.parse(current.lease.until) <= now) {
        await this.store.transact(intentId, this.worker, () => ({
          type: 'submit_result', fence, attempt, outcome: 'not_submitted', error: 'fence superseded or lease expired before the transport call; nothing was submitted',
        }));
        return this.fenced(intentId, fence, 'submit', `fence ${fence} superseded before the transport call`, submitted);
      }
      await this.point('after_final_check', current);

      const result = await this.submitOnce(current, attempt);
      submitted += 1;
      await this.point('after_ack', current);
      const recorded = await this.store.transact(intentId, this.worker, () => ({ type: 'submit_result', fence, attempt, ...result }));
      record = recorded.record;
      await this.point('after_result', record);
      if (record.fence !== fence) {
        // This worker's result arrived after a takeover: recorded as a fact about its attempt, nothing else is done.
        return { kind: result.outcome === 'accepted' ? 'accepted' : 'fenced', submitted, record, late: true, ...(result.error ? { reason: result.error } : {}) };
      }
      if (result.outcome === 'accepted') return this.observe(intentId, fence, submitted);
      // 'unknown' goes to reconciliation on the next turn; 'not_accepted' goes to the retry rules.
    }
  }
}

/** Dispatch-time recheck of the policy over the intent's stored message (OS-POL-01: re-evaluate at the side effect). */
export function policyRecheck(
  config: PolicyConfig,
  context: { clock: () => Date; verifier?: PolicyEvidenceVerifier; approvalState?: (approvalId: string) => Promise<ApprovalState | undefined> },
): (record: SendRecord) => Promise<DispatchCheck> {
  return async (record) => {
    const i = record.intent;
    const action: ProposedAction = {
      category: i.action.category,
      level: i.action.level,
      external: true,
      from: i.message.from,
      to: i.message.to,
      cc: i.message.cc,
      bcc: i.message.bcc,
      subject: i.message.subject,
      text: i.message.body,
      attachments: i.message.attachments,
      drawingChecks: i.action.drawingChecks,
      templateId: i.templateId,
      templateVersion: i.templateVersion,
      supervisor: i.action.supervisor,
      disclosureRendered: i.action.disclosureRendered,
    };
    let approval: ApprovalState | undefined;
    if (i.authorization.kind === 'approval') {
      approval = await context.approvalState?.(i.authorization.approvalId);
      if (!approval) return { ok: false, reasons: [`approval ${i.authorization.approvalId} is not on record`] };
    }
    const r = recheckAtDispatch(action, approval, config, { now: context.clock(), verifier: context.verifier });
    return r.decision === 'allow' ? { ok: true } : { ok: false, reasons: [`policy rechecked at dispatch: ${r.decision}`, ...r.reasons] };
  };
}

/** The approval state of an approval id as the queue holds it. */
export function approvalStateFrom(queue: ApprovalQueue): (approvalId: string) => Promise<ApprovalState | undefined> {
  return async (approvalId) => {
    const view = (await queue.list()).find((v) => v.id === approvalId);
    return view ? { status: view.status } : undefined;
  };
}

/** Escalation as an approval request for a person: the worker stops; nothing is resent. */
export function escalateTo(queue: ApprovalQueue, requestedBy: string): (record: SendRecord, reason: string) => Promise<string> {
  return async (record, reason) => {
    const req = await queue.request({
      requestedBy,
      category: record.intent.action.category,
      summary: `Send record needs a person: ${sendRecordSummary(record)}`,
      payload: {
        intentId: record.intentId,
        correlationId: record.intent.correlationId,
        key: record.intent.key,
        attempts: record.attempts.map((a) => ({ attempt: a.attempt, worker: a.worker, startedAt: a.startedAt, outcome: a.result?.outcome ?? 'no result recorded' })),
        reconcileQueries: record.reconcileQueries,
      },
      reasons: [reason, 'do not resend before the provider proves the earlier attempt was not accepted'],
    });
    return req.id;
  };
}

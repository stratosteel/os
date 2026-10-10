/**
 * Layer 6: an approval bound to exactly what leaves (A11 of the functional specification; G3-A11 of the independent
 * review of 2026-10-07: "a changed drawing invalidates the approval").
 *
 * The binding is computed by the server from trusted state, never from a worker's payload: tenant, job, intent id,
 * sending identity, the full recipient set, the rendered message hash, template id and version, policy version, every
 * attachment's document id, immutable revision, the SHA-256 of its bytes in the document registry and the registry's
 * current revision, and the named drawing clearances (each check with checker and time) recorded in the registry. An
 * approval request for a send carries the binding and its hash; a decision must name that hash (approvals.ts) and comes
 * from an authenticated approver (approvers.ts).
 *
 * At the dispatch boundary the gate re-reads trusted current state under the registry's version fence and recomputes
 * the binding. Equal: the fence line records the check and the exact bytes are handed to the transport. Different
 * (a new revision, new bytes under the same file name, other recipients or body, another policy version, a revoked,
 * rejected, generic or unauthenticated approval): the fence records a refusal, 0 transport calls, and a new approval
 * requirement is filed. A change after a completed dispatch cannot unsend anything: checkSupersession keeps the sent
 * snapshot, marks the record superseded and asks a person; it never resends.
 */
import type { ApprovalQueue, ApprovalView } from './approvals.js';
import type { ApproverRegistry } from './approvers.js';
import type { DocumentRegistry, RegistryState } from './document_registry.js';
import { canonicalJson, messageContentHash, normalizeMessage, sha256Hex } from './message.js';
import type { AttachmentEvidence, PolicyConfig } from './policy.js';
import type { DispatchGate, GateResult } from './send_dispatcher.js';
import { effectiveApprovalId, intentIdOf, normalizeIntentKey, policyVersionOf, type SendIntentInput, type SendRecord, type SendRecordStore } from './send_record.js';

export interface BoundAttachment {
  documentId: string;
  /** The revision the message carries. */
  revision: string;
  filename: string;
  kind: 'drawing' | 'document';
  /** SHA-256 of that revision's bytes in the registry. */
  sha256: string | null;
  /** The registry's current revision of the document. */
  currentRevision: string | null;
}

export interface DrawingClearance {
  documentId: string;
  revision: string;
  checks: { check: string; by: string; at: string }[];
}

export interface ApprovalBinding {
  schema: 'stratosteel-os/approval-binding/v1';
  tenant: string;
  jobId: string | null;
  intentId: string;
  from: string;
  recipients: { to: string[]; cc: string[]; bcc: string[] };
  renderedHash: string;
  templateId: string;
  templateVersion: string;
  policyVersion: string;
  attachments: BoundAttachment[];
  drawingClearances: DrawingClearance[];
}

/** The send a binding is computed for: a stored intent, or the input of one not created yet (its id follows from its key). */
export interface BindingSubject {
  tenant: string;
  jobId?: string;
  intentId: string;
  category: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  contentHash: string;
  templateId: string;
  templateVersion: string;
  attachments: AttachmentEvidence[];
}

export function subjectOfRecord(record: SendRecord): BindingSubject {
  const i = record.intent;
  return {
    tenant: i.key.tenant,
    ...(i.jobId ? { jobId: i.jobId } : {}),
    intentId: i.intentId,
    category: i.action.category,
    from: i.message.from.address,
    to: i.message.to.map((a) => a.address),
    cc: i.message.cc.map((a) => a.address),
    bcc: i.message.bcc.map((a) => a.address),
    contentHash: i.contentHash,
    templateId: i.templateId,
    templateVersion: i.templateVersion,
    attachments: i.message.attachments,
  };
}

export function subjectOfInput(input: SendIntentInput): BindingSubject {
  const key = normalizeIntentKey(input.key);
  const m = normalizeMessage(input.message);
  return {
    tenant: key.tenant,
    ...(input.jobId?.trim() ? { jobId: input.jobId.trim() } : {}),
    intentId: intentIdOf(key),
    category: input.action.category,
    from: m.from.address,
    to: m.to.map((a) => a.address),
    cc: m.cc.map((a) => a.address),
    bcc: m.bcc.map((a) => a.address),
    contentHash: messageContentHash(m),
    templateId: input.templateId.trim(),
    templateVersion: input.templateVersion.trim(),
    attachments: m.attachments,
  };
}

export function bindingHashOf(binding: ApprovalBinding): string {
  return sha256Hex(canonicalJson(binding));
}

const short = (sha: string | null | undefined) => (sha ? `${sha.slice(0, 12)}...` : 'none');

/**
 * The binding of a send against a registry state. `errors` make it unapprovable as it stands (a document or revision
 * that is missing, bytes that differ from the message's manifest, a drawing without the required named checks);
 * `warnings` are facts the approver must see (the message carries a revision that is no longer current).
 */
export function computeBinding(subject: BindingSubject, state: RegistryState, policyVersion: string, drawingChecksRequired: number): { binding: ApprovalBinding; hash: string; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const attachments: BoundAttachment[] = subject.attachments.map((a) => {
    const doc = state.documents.get(a.documentId);
    const rev = doc?.revisions.get(a.revision);
    if (!doc) errors.push(`document ${a.documentId} is not in the registry`);
    else if (!rev) errors.push(`document ${a.documentId} has no revision ${a.revision} in the registry`);
    else {
      if (rev.sha256 !== a.sha256.toLowerCase()) errors.push(`document ${a.documentId} revision ${a.revision}: the registry holds bytes ${short(rev.sha256)}, the message manifest names ${short(a.sha256)} (new bytes under the same file name)`);
      if (rev.filename !== a.filename) errors.push(`document ${a.documentId} revision ${a.revision}: the registry names the file ${rev.filename}, the message ${a.filename}`);
      if (rev.kind !== a.kind) errors.push(`document ${a.documentId} revision ${a.revision}: the registry records a ${rev.kind}, the message a ${a.kind}`);
      if (doc.current !== a.revision) warnings.push(`document ${a.documentId}: the message carries revision ${a.revision}, revision ${doc.current} is current`);
    }
    return { documentId: a.documentId, revision: a.revision, filename: a.filename, kind: rev?.kind ?? a.kind, sha256: rev?.sha256 ?? null, currentRevision: doc?.current ?? null };
  });
  const drawingClearances: DrawingClearance[] = attachments
    .filter((a) => a.kind !== 'document')
    .map((a) => {
      const checks = state.checks
        .filter((c) => c.documentId === a.documentId && c.revision === a.revision && c.check.trim() && c.by.trim() && !Number.isNaN(Date.parse(c.at)))
        .map((c) => ({ check: c.check, by: c.by, at: c.at }))
        .sort((x, y) => canonicalJson(x).localeCompare(canonicalJson(y)));
      const distinct = new Set(checks.map((c) => c.check.trim().toLowerCase()));
      if (distinct.size < drawingChecksRequired) {
        errors.push(`drawing ${a.documentId} revision ${a.revision} has ${distinct.size} of ${drawingChecksRequired} named checks recorded in the registry`);
      }
      return { documentId: a.documentId, revision: a.revision, checks };
    });
  const binding: ApprovalBinding = {
    schema: 'stratosteel-os/approval-binding/v1',
    tenant: subject.tenant,
    jobId: subject.jobId ?? null,
    intentId: subject.intentId,
    from: subject.from,
    recipients: { to: [...subject.to].sort(), cc: [...subject.cc].sort(), bcc: [...subject.bcc].sort() },
    renderedHash: subject.contentHash,
    templateId: subject.templateId,
    templateVersion: subject.templateVersion,
    policyVersion,
    attachments,
    drawingClearances,
  };
  return { binding, hash: bindingHashOf(binding), errors, warnings };
}

function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value === null || typeof value !== 'object') {
    out.set(prefix, JSON.stringify(value ?? null));
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) out.set(prefix, '[]');
    value.forEach((v, i) => {
      const id = v && typeof v === 'object' && typeof (v as { documentId?: unknown }).documentId === 'string' ? (v as { documentId: string }).documentId : String(i);
      flatten(v, `${prefix}[${id}]`, out);
    });
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
}

/** Every field that differs between the approved binding and the binding of the current trusted state. */
export function diffBindings(approved: unknown, current: ApprovalBinding): string[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  flatten(approved, '', a);
  flatten(current, '', b);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  return keys.filter((k) => a.get(k) !== b.get(k)).map((k) => `${k}: ${a.get(k) ?? 'absent'} -> ${b.get(k) ?? 'absent'}`);
}

export interface BindingContext {
  approvals: ApprovalQueue;
  registry: DocumentRegistry;
  policy: PolicyConfig;
  /** Identity recorded as the requester of approval requests the server files. */
  requestedBy: string;
}

/**
 * File an approval request for a send with the binding computed by the server from the registry. Refuses a send that
 * cannot be approved as it stands (see computeBinding errors).
 */
export async function requestSendApproval(o: BindingContext, subject: BindingSubject, reasons: string[], extra: { amount?: number } = {}): Promise<{ approvalId: string; bindingHash: string; binding: ApprovalBinding }> {
  const { binding, hash, errors, warnings } = computeBinding(subject, await o.registry.state(), policyVersionOf(o.policy), o.policy.drawingChecksRequired);
  if (errors.length) throw new Error(`no approval can be requested for ${subject.intentId}: ${errors.join('; ')}`);
  const req = await o.approvals.request({
    requestedBy: o.requestedBy,
    category: subject.category,
    summary: `Send ${subject.intentId}: ${binding.from} to ${binding.recipients.to.join(', ')}; ${binding.attachments.map((a) => `${a.filename} revision ${a.revision}`).join(', ') || 'no attachments'}`,
    payload: {},
    reasons: [...reasons, ...warnings],
    tenant: binding.tenant,
    ...(binding.jobId ? { jobId: binding.jobId } : {}),
    ...(extra.amount !== undefined ? { amount: extra.amount } : {}),
    binding,
    bindingHash: hash,
  });
  return { approvalId: req.id, bindingHash: hash, binding };
}

/**
 * File a review request for a send that cannot be approved as it stands. It carries no binding, so it can never
 * authorize a send: the message has to be prepared again (a new revision of the inquiry) and approved on its own.
 */
export async function requestSendReview(o: BindingContext, subject: BindingSubject, reasons: string[]): Promise<{ approvalId: string; bindingHash: string }> {
  const req = await o.approvals.request({
    requestedBy: o.requestedBy,
    category: subject.category,
    summary: `Review required, nothing can be sent as stored: ${subject.intentId}`,
    payload: {},
    reasons: [...reasons, 'this request carries no binding and cannot authorize a send; prepare a new revision of the message'],
    tenant: subject.tenant,
    ...(subject.jobId ? { jobId: subject.jobId } : {}),
  });
  return { approvalId: req.id, bindingHash: '' };
}

export interface ApprovalBindingGateOptions {
  registry: DocumentRegistry;
  approvals: ApprovalQueue;
  policy: PolicyConfig;
  /** Identity recorded on the approval requests the gate files (default: the dispatching worker). */
  requestedBy?: string;
  /** When given, the deciding approver must still hold a scope that covers the request at dispatch. */
  approvers?: ApproverRegistry;
}

/** The A11 dispatch gate: approval and trusted current state re-read and compared under the registry's version fence. */
export class ApprovalBindingGate implements DispatchGate {
  constructor(private readonly o: ApprovalBindingGateOptions) {}

  async check(record: SendRecord, context: { worker: string; fence: number; attempt: number }): Promise<GateResult> {
    const subject = subjectOfRecord(record);
    const ctx: BindingContext = { approvals: this.o.approvals, registry: this.o.registry, policy: this.o.policy, requestedBy: this.o.requestedBy ?? context.worker };
    const approvalId = effectiveApprovalId(record);
    const last = record.approvalChain[record.approvalChain.length - 1];
    // The approval is read under the queue's lock and the registry fence is taken inside it: a decision or revocation is
    // either seen here or recorded after the fence line, never in between.
    return this.o.approvals.readLocked((approvals) => this.decide(record, context, ctx, subject, approvalId, approvalId ? approvals.get(approvalId) : undefined, last));
  }

  private async decide(
    record: SendRecord,
    context: { worker: string; fence: number; attempt: number },
    ctx: BindingContext,
    subject: BindingSubject,
    approvalId: string | undefined,
    approval: ApprovalView | undefined,
    last: SendRecord['approvalChain'][number] | undefined,
  ): Promise<GateResult> {
    if (last && last.bindingHash === '') {
      return { ok: false, reasons: [`review ${last.approvalId} is ${approval?.status ?? 'not on record'}: the stored message cannot be sent; a new revision of the message is required`] };
    }
    const seen = approvalId ? { approval: { approvalId, status: approval?.status ?? 'not on record' } } : {};
    const pre: string[] = [];
    if (approvalId) {
      if (!approval) pre.push(`approval ${approvalId} is not on record`);
      else if (approval.status === 'pending') return { ok: false, reasons: [`approval ${approvalId} is pending: a person has not decided yet`] };
      else if (approval.status === 'rejected') return { ok: false, reasons: [`approval ${approvalId} was rejected by ${approval.decision?.decidedBy}: nothing is sent`] };
      else {
        if (approval.status === 'revoked') pre.push(`approval ${approvalId} was revoked by ${approval.revocation?.revokedBy} at ${approval.revocation?.revokedAt}`);
        if (approval.binding === undefined || approval.bindingHash === undefined) {
          pre.push(`approval ${approvalId} carries no binding computed by the server: a generic approval or a worker-supplied payload does not authorize a send`);
        } else {
          if (approval.decision?.bindingHash !== approval.bindingHash) pre.push(`the decision on approval ${approvalId} does not name the binding it approved`);
          if (!approval.decision?.approverId) pre.push(`approval ${approvalId} was not decided by an authenticated approver`);
          else if (this.o.approvers) {
            const scope = this.o.approvers.scopeFor(approval.decision.approverId, { tenant: approval.tenant, category: approval.category, jobId: approval.jobId, amount: approval.amount });
            if (!scope.ok) pre.push(`approval ${approvalId}: ${scope.reason}`);
          }
        }
      }
    }
    return this.o.registry.fence(async (state, ops): Promise<GateResult> => {
      const current = computeBinding(subject, state, policyVersionOf(this.o.policy), this.o.policy.drawingChecksRequired);
      const reasons = [...pre, ...current.errors];
      if (approvalId) {
        if (approval?.binding !== undefined && approval.bindingHash !== undefined && approval.bindingHash !== current.hash) {
          const diff = diffBindings(approval.binding, current.binding);
          reasons.push(...(diff.length ? diff : ['the binding hash differs']).map((d) => `stale approval ${approvalId}: ${d}`));
        }
      } else {
        // A policy-allowed (autonomous) send: what the policy allowed must still be the current trusted state.
        for (const a of current.binding.attachments) {
          if (a.currentRevision !== null && a.currentRevision !== a.revision) {
            reasons.push(`document ${a.documentId}: revision ${a.currentRevision} is current, the message carries revision ${a.revision}; a changed drawing ends the autonomous permission`);
          }
        }
      }
      if (reasons.length) {
        const seq = await ops.refuse({ type: 'dispatch_refused', intentId: record.intentId, worker: context.worker, sendFence: context.fence, attempt: context.attempt, reasons, ...seen });
        const why = [...reasons, `refused at registry version ${seq}`];
        const newApproval = current.errors.length ? () => requestSendReview(ctx, subject, why) : () => requestSendApproval(ctx, subject, why);
        return { ok: false, reasons: why, newApproval };
      }
      const attachments = [];
      for (const a of current.binding.attachments) attachments.push({ documentId: a.documentId, revision: a.revision, bytes: await ops.readBytes(a.documentId, a.revision) });
      const seq = await ops.commit({
        type: 'dispatch_fence',
        intentId: record.intentId,
        worker: context.worker,
        sendFence: context.fence,
        attempt: context.attempt,
        bindingHash: approvalId ? current.hash : null,
        documents: current.binding.attachments.map((a) => ({ documentId: a.documentId, revision: a.revision, sha256: a.sha256 ?? '' })),
        ...seen,
      });
      return { ok: true, attachments, bindingHash: current.hash, registrySeq: seq };
    });
  }
}

/**
 * After a dispatch: if a bound document changed after the dispatch fence (a new revision, or new bytes for the sent
 * revision), keep the sent snapshot, mark the record superseded and ask a person. Never resends. Idempotent per change.
 */
export async function checkSupersession(
  o: { store: SendRecordStore; registry: DocumentRegistry; worker: string; escalate?: (record: SendRecord, reason: string) => Promise<string | undefined> },
  intentId: string,
): Promise<SendRecord> {
  let record = await o.store.read(intentId);
  const dispatched = [...record.attempts].reverse().find((a) => a.registrySeq !== undefined && a.attachmentBytes && a.result?.outcome !== 'not_accepted' && a.result?.outcome !== 'not_submitted');
  if (!dispatched) return record;
  const state = await o.registry.state();
  for (const sent of dispatched.attachmentBytes!) {
    const doc = state.documents.get(sent.documentId);
    if (!doc) continue;
    const currentSha = doc.revisions.get(doc.current)?.sha256 ?? '';
    if (doc.current === sent.revision && currentSha === sent.sha256) continue;
    const change = state.log.find((e) => e.seq > dispatched.registrySeq! && (e.type === 'revision_added' || e.type === 'bytes_replaced') && e.documentId === sent.documentId);
    if (!change || record.superseded.some((x) => x.documentId === sent.documentId && x.changeSeq === change.seq)) continue;
    const reason = `document ${sent.documentId} changed after the dispatch fence (registry ${dispatched.registrySeq} -> ${change.seq}): revision ${sent.revision} was sent, revision ${doc.current} is current; the sent snapshot is kept and nothing is resent`;
    let approvalId: string | undefined;
    try {
      approvalId = await o.escalate?.(record, reason);
    } catch {
      approvalId = undefined;
    }
    const r = await o.store.transact(intentId, o.worker, () => ({
      type: 'superseded',
      documentId: sent.documentId,
      sentRevision: sent.revision,
      currentRevision: doc.current,
      sentSha256: sent.sha256,
      currentSha256: currentSha,
      dispatchSeq: dispatched.registrySeq!,
      changeSeq: change.seq,
      ...(approvalId ? { approvalId } : {}),
    }));
    record = r.record;
  }
  return record;
}

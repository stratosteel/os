/**
 * Shared fixtures for the approval-binding (A11), approver-scope (A10) and rendered-disclosure tests. Invented names,
 * example.com addresses, synthetic bytes, approver keys generated at run time (no key is stored anywhere).
 */
import path from 'node:path';
import { ApprovalQueue } from '../src/approvals.js';
import { ApprovalBindingGate, requestSendApproval, subjectOfInput } from '../src/approval_binding.js';
import type { ApproverRegistry, DecisionKind } from '../src/approvers.js';
import { DocumentRegistry } from '../src/document_registry.js';
import { sha256Hex } from '../src/message.js';
import type { PolicyConfig } from '../src/policy.js';
import { createServer } from '../src/server.js';
import { SendDispatcher, escalateTo, type DispatcherOptions } from '../src/send_dispatcher.js';
import { SendRecordStore, type SendIntentInput } from '../src/send_record.js';
import { FakeTransport, type FakeScript } from '../src/transport.js';
import { CONFIG } from './policy_fixtures.js';
import { intentInput, workspace, type Workspace } from './send_fixtures.js';
import { approverRegistry, decisionToken, makeApprover, tool, type Approver } from './approver_fixtures.js';

export { TENANT, approverRegistry, decisionToken, makeApprover, tool, type Approver } from './approver_fixtures.js';

const bytes = (text: string) => new TextEncoder().encode(text);
export const DRAWING_R3 = bytes('%PDF-1.7\n% synthetic test drawing ACME-HALL-FRAME, revision 3\n');
export const DRAWING_R4 = bytes('%PDF-1.7\n% synthetic test drawing ACME-HALL-FRAME, revision 4\n');
export const DRAWING_R3_EDITED = bytes('%PDF-1.7\n% synthetic test drawing ACME-HALL-FRAME, revision 3, edited in place\n');
export const SCOPE_R1 = bytes('%PDF-1.7\n% synthetic RFQ scope ACME-RFQ-0001, revision 1\n');
export const sha = (b: Uint8Array) => sha256Hex(b);

export const DRAWING_ID = 'doc-0101';
export const SCOPE_ID = 'doc-0102';
export const JOB_ID = 'DOP-2026-001';

export const CHECKS = [
  { check: 'text-scan', by: 'scan-agent-1', at: '2026-10-10T07:10:00.000Z' },
  { check: 'graphics-scan', by: 'scan-agent-2', at: '2026-10-10T07:12:00.000Z' },
  { check: 'title-block-review', by: 'M. Example', at: '2026-10-10T07:30:00.000Z' },
];

export const DRAWING_REV3 = { documentId: DRAWING_ID, revision: '3', sha256: sha(DRAWING_R3), filename: 'hall_frame_rev3.pdf', kind: 'drawing' as const };
export const SCOPE_REV1 = { documentId: SCOPE_ID, revision: '1', sha256: sha(SCOPE_R1), filename: 'rfq_scope_rev1.pdf', kind: 'document' as const };

/** The trusted document store: drawing revision 3 with its three named checks (or fewer), scope revision 1. */
export async function seedRegistry(dir: string, checks = CHECKS.length): Promise<DocumentRegistry> {
  const registry = await DocumentRegistry.init(dir);
  await registry.addRevision(DRAWING_ID, { revision: '3', filename: 'hall_frame_rev3.pdf', kind: 'drawing', bytes: DRAWING_R3 }, 'M. Example');
  for (const c of CHECKS.slice(0, checks)) await registry.recordCheck(DRAWING_ID, '3', c.check, c.by, c.at);
  await registry.addRevision(SCOPE_ID, { revision: '1', filename: 'rfq_scope_rev1.pdf', kind: 'document', bytes: SCOPE_R1 }, 'M. Example');
  return registry;
}

export async function addRevision4(registry: DocumentRegistry): Promise<number> {
  return (await registry.addRevision(DRAWING_ID, { revision: '4', filename: 'hall_frame_rev4.pdf', kind: 'drawing', bytes: DRAWING_R4 }, 'M. Example')).seq;
}

/** A supplier inquiry with the scope and drawing revision 3, released by a person (drawing_release). */
export function drawingSend(overrides: Partial<SendIntentInput> = {}): SendIntentInput {
  const base = intentInput();
  return intentInput({
    jobId: JOB_ID,
    message: { ...base.message, attachments: [SCOPE_REV1, DRAWING_REV3] },
    action: { category: 'drawing_release', level: 'L2', supervisor: 'M. Example', disclosureRendered: true },
    ...overrides,
  });
}

export interface BindingEnv {
  ws: Workspace;
  store: SendRecordStore;
  transport: FakeTransport;
  registry: DocumentRegistry;
  queue: ApprovalQueue;
  approver: Approver;
  approvers: ApproverRegistry;
  policy: PolicyConfig;
  registryLog: string;
  /** Decide (or revoke) an approval the way a person does: through the human tool with a signed token. */
  decide(approvalId: string, decision: DecisionKind): Promise<unknown>;
  /** Request the approval of a send (binding computed by the server), approve it through the tool, then create the intent. */
  approvedIntent(input: SendIntentInput): Promise<{ id: string; approvalId: string; bindingHash: string }>;
  dispatcher(worker: string, options?: Partial<DispatcherOptions>, gatePolicy?: PolicyConfig): SendDispatcher;
}

export async function bindingEnv(caseName: string, opts: { checks?: number; script?: FakeScript; policy?: PolicyConfig } = {}): Promise<BindingEnv> {
  const ws = await workspace(caseName);
  const store = await SendRecordStore.init(ws.storeDir);
  const transport = await FakeTransport.create(ws.transportDir, opts.script ?? {});
  const registryDir = path.join(ws.root, 'registry');
  const registry = await seedRegistry(registryDir, opts.checks);
  const queue = new ApprovalQueue(path.join(ws.root, 'approvals.jsonl'));
  const approver = makeApprover();
  const approvers = approverRegistry([{ approver }]);
  const policy = opts.policy ?? CONFIG;
  const human = await createServer({ stateDir: ws.root, role: 'human', caller: 'M. Example', approvers, policy });
  const decide = async (approvalId: string, decision: DecisionKind) => {
    const request = await queue.get(approvalId);
    const token = decisionToken(approver, approvalId, decision, request?.bindingHash ?? null);
    if (decision === 'revoked') return tool(human.tools, 'approval_revoke').handler({ id: approvalId, token });
    return tool(human.tools, 'approval_decide').handler({ id: approvalId, decision, token, note: `${decision} after review of the exact binding` });
  };
  return {
    ws, store, transport, registry, queue, approver, approvers, policy,
    registryLog: path.join(registryDir, 'log.jsonl'),
    decide,
    approvedIntent: async (input) => {
      const req = await requestSendApproval({ approvals: queue, registry, policy, requestedBy: input.createdBy.worker }, subjectOfInput(input), ['drawing_release always needs a person']);
      await decide(req.approvalId, 'approved');
      const created = await store.create({ ...input, authorization: { kind: 'approval', approvalId: req.approvalId } });
      return { id: created.record.intentId, approvalId: req.approvalId, bindingHash: req.bindingHash };
    },
    dispatcher: (worker, options = {}, gatePolicy) =>
      new SendDispatcher({
        store, transport, worker, leaseMs: 5_000, retryBackoffMs: 5, reconcileBackoffMs: 5,
        gate: new ApprovalBindingGate({ registry, approvals: queue, policy: gatePolicy ?? policy, approvers }),
        escalate: escalateTo(queue, worker),
        ...options,
      }),
  };
}

/**
 * Approver fixtures for the A10 and A11 tests: approver keys generated at run time (no key is stored anywhere), the
 * registry a server is configured with, and decision tokens as an approver's authenticated client would sign them.
 */
import { randomBytes } from 'node:crypto';
import { ApproverRegistry, signDecision, type ApproverScope, type DecisionKind, type DecisionToken } from '../src/approvers.js';
import type { ToolDef } from '../src/tools.js';

export const TENANT = 'tenant-template';

export interface Approver {
  id: string;
  name: string;
  key: string;
}

export function makeApprover(id = 'approver-1', name = 'M. Example'): Approver {
  return { id, name, key: randomBytes(32).toString('base64') };
}

export const BROAD_SCOPE: ApproverScope[] = [{ tenant: TENANT, categories: ['drawing_release', 'supplier_inquiry', 'customer_quote', 'order'] }];

export function approverRegistry(entries: { approver: Approver; scopes?: ApproverScope[] }[]): ApproverRegistry {
  return new ApproverRegistry(entries.map(({ approver, scopes }) => ({ ...approver, scopes: scopes ?? BROAD_SCOPE })));
}

export function decisionToken(a: Approver, approvalId: string, decision: DecisionKind, bindingHash: string | null, issuedAt = new Date(), ttlMs = 300_000): DecisionToken {
  return signDecision(a.key, { approverId: a.id, approvalId, decision, bindingHash, issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString() });
}

export function tool(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t;
}

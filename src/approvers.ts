/**
 * Layer 6: who may decide an approval (A10 of the functional specification; OS-POL-01 and OS-APP-01 of the independent
 * review of 2026-10-07: OS_ROLE and OS_CALLER are startup configuration, not proof of an authenticated human).
 *
 * The server holds an ApproverRegistry in its own configuration (a file outside the repository, keys from the host's
 * secret store): each approver has an id, the name that appears on decisions, scopes (tenant, categories, optional jobs,
 * optional amount ceiling) and an HMAC-SHA256 key. A decision arrives with a decision token signed with that key by the
 * approver's authenticated client: approver id, approval id, decision, the binding hash the approver saw, issue and
 * expiry time. The server verifies the signature, the claims against the request, the time against its own clock and
 * the scope, and records the registry's name for the approver. Nothing the caller says about itself counts.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './message.js';

export interface ApproverScope {
  tenant: string;
  /** Approval categories this approver may decide (policy ActionCategory values). */
  categories: string[];
  /** Jobs this approver may decide; absent means every job of the tenant. */
  jobs?: string[];
  /** Highest amount this approver may approve, in the request's currency; absent means no ceiling. */
  maxAmount?: number;
}

export interface ApproverConfig {
  id: string;
  /** The named person exactly as decisions record them. */
  name: string;
  scopes: ApproverScope[];
  /** HMAC-SHA256 key, base64. Held by the server configuration and the approver's client, never by a worker. */
  key: string;
}

export type DecisionKind = 'approved' | 'rejected' | 'revoked';

export interface DecisionClaims {
  approverId: string;
  approvalId: string;
  decision: DecisionKind;
  /** The binding hash of the request the approver saw, or null for a request without a binding. */
  bindingHash: string | null;
  issuedAt: string;
  expiresAt: string;
}

export interface DecisionToken extends DecisionClaims {
  /** Hex HMAC-SHA256 of the canonical claims under the approver's key. */
  signature: string;
}

/** What an approval is about, for the scope check. */
export interface ApprovalSubject {
  tenant?: string;
  category: string;
  jobId?: string;
  amount?: number;
}

export interface VerifiedApprover {
  id: string;
  name: string;
}

function claimsOf(t: DecisionClaims): DecisionClaims {
  return { approverId: t.approverId, approvalId: t.approvalId, decision: t.decision, bindingHash: t.bindingHash ?? null, issuedAt: t.issuedAt, expiresAt: t.expiresAt };
}

function hmacHex(key: Uint8Array, claims: DecisionClaims): string {
  return createHmac('sha256', key).update(canonicalJson(claimsOf(claims))).digest('hex');
}

const keyBytes = (key: string | Uint8Array): Uint8Array => (typeof key === 'string' ? Buffer.from(key, 'base64') : key);

/** Sign decision claims with an approver's key: what the approver's authenticated client does. */
export function signDecision(key: string | Uint8Array, claims: DecisionClaims): DecisionToken {
  return { ...claimsOf(claims), signature: hmacHex(keyBytes(key), claims) };
}

export interface ApproverRegistryOptions {
  /** Longest accepted lifetime of a token, in milliseconds (default 15 minutes). */
  maxTokenAgeMs?: number;
}

export class ApproverRegistry {
  private readonly byId = new Map<string, ApproverConfig & { keyBytes: Uint8Array }>();
  private readonly maxTokenAgeMs: number;

  constructor(approvers: ApproverConfig[], options: ApproverRegistryOptions = {}) {
    for (const a of approvers) {
      if (!a.id?.trim() || !a.name?.trim()) throw new Error('every approver needs an id and a name');
      const bytes = keyBytes(a.key ?? '');
      if (bytes.length < 32) throw new Error(`approver ${a.id} needs a key of at least 32 bytes (base64)`);
      if (!Array.isArray(a.scopes) || a.scopes.length === 0) throw new Error(`approver ${a.id} needs at least one scope`);
      if (this.byId.has(a.id)) throw new Error(`approver ${a.id} is configured twice`);
      this.byId.set(a.id, { ...a, keyBytes: bytes });
    }
    this.maxTokenAgeMs = options.maxTokenAgeMs ?? 15 * 60_000;
  }

  /** The registry from a JSON list of ApproverConfig (a server configuration file, never the repository). */
  static fromJson(text: string, options?: ApproverRegistryOptions): ApproverRegistry {
    return new ApproverRegistry(JSON.parse(text) as ApproverConfig[], options);
  }

  has(approverId: string): boolean {
    return this.byId.has(approverId);
  }

  nameOf(approverId: string): string | undefined {
    return this.byId.get(approverId)?.name;
  }

  /** Whether the approver's scopes cover this subject, with the reason when they do not. */
  scopeFor(approverId: string, subject: ApprovalSubject): { ok: true } | { ok: false; reason: string } {
    const a = this.byId.get(approverId);
    if (!a) return { ok: false, reason: `approver ${approverId} is not configured on this server` };
    const tenant = a.scopes.filter((s) => s.tenant === subject.tenant);
    if (!tenant.length) return { ok: false, reason: `approver ${a.id} has no scope in tenant ${subject.tenant ?? '(none)'}` };
    const category = tenant.filter((s) => s.categories.includes(subject.category));
    if (!category.length) return { ok: false, reason: `approver ${a.id} may not decide ${subject.category} in tenant ${subject.tenant}` };
    const job = category.filter((s) => !s.jobs || (subject.jobId !== undefined && s.jobs.includes(subject.jobId)));
    if (!job.length) return { ok: false, reason: `job ${subject.jobId ?? '(none)'} is outside the scope of approver ${a.id}` };
    if (subject.amount !== undefined) {
      const within = job.filter((s) => s.maxAmount === undefined || subject.amount! <= s.maxAmount);
      if (!within.length) {
        const ceiling = Math.max(...job.map((s) => s.maxAmount ?? 0));
        return { ok: false, reason: `amount ${subject.amount} exceeds the ceiling ${ceiling} of approver ${a.id}` };
      }
    }
    return { ok: true };
  }

  /**
   * Verify a decision token for one request: a configured approver, a valid signature, claims that name this request,
   * this decision and this binding, a lifetime the server's clock accepts, and a scope that covers the subject.
   */
  verify(
    token: DecisionToken | undefined,
    expected: { approvalId: string; decision: DecisionKind; bindingHash: string | null; subject: ApprovalSubject },
    now: Date,
  ): { ok: true; approver: VerifiedApprover } | { ok: false; reason: string } {
    if (!token || typeof token !== 'object') return { ok: false, reason: 'a decision needs a decision token signed by a configured approver; the caller identity is not proof' };
    const a = this.byId.get(token.approverId);
    if (!a) return { ok: false, reason: `approver ${String(token.approverId)} is not configured on this server` };
    let signature: Buffer;
    try {
      signature = Buffer.from(String(token.signature), 'hex');
    } catch {
      return { ok: false, reason: 'the decision token signature is not hex' };
    }
    const expectedSignature = Buffer.from(hmacHex(a.keyBytes, token), 'hex');
    if (signature.length !== expectedSignature.length || !timingSafeEqual(signature, expectedSignature)) {
      return { ok: false, reason: `the decision token is not signed with the key of approver ${a.id}` };
    }
    if (token.approvalId !== expected.approvalId) return { ok: false, reason: `the token names approval ${token.approvalId}, not ${expected.approvalId}` };
    if (token.decision !== expected.decision) return { ok: false, reason: `the token decides ${token.decision}, not ${expected.decision}` };
    if ((token.bindingHash ?? null) !== expected.bindingHash) {
      return { ok: false, reason: `the token names binding ${token.bindingHash ?? 'none'}, the request binds ${expected.bindingHash ?? 'none'}` };
    }
    const issued = Date.parse(token.issuedAt);
    const expires = Date.parse(token.expiresAt);
    if (Number.isNaN(issued) || Number.isNaN(expires) || expires <= issued) return { ok: false, reason: 'the decision token has no valid lifetime' };
    if (expires - issued > this.maxTokenAgeMs) return { ok: false, reason: `the decision token lives longer than ${this.maxTokenAgeMs} ms` };
    if (now.getTime() < issued - 60_000) return { ok: false, reason: 'the decision token is not valid yet' };
    if (now.getTime() >= expires) return { ok: false, reason: `the decision token expired at ${token.expiresAt}` };
    const scope = this.scopeFor(a.id, expected.subject);
    if (!scope.ok) return scope;
    return { ok: true, approver: { id: a.id, name: a.name } };
  }
}

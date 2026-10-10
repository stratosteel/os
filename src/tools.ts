/**
 * Layer 5, the access door: tool definitions independent of the transport.
 * Every AI (chat assistant, coding agent, worker) reaches mail, files, records and memory only through these
 * tools, so the same policy and the same records apply whatever model or vendor is on the other side.
 * `server.ts` registers them with the MCP SDK; tests call the handlers directly.
 */
import * as z from 'zod/v4';
import type { Providers } from './providers.js';
import { ApprovalQueue, type ApprovalView } from './approvals.js';
import type { AccessScopes } from './access.js';
import type { ApproverRegistry, DecisionKind, DecisionToken } from './approvers.js';
import { decide, DEFAULT_POLICY, type PolicyConfig, type PolicyEvidenceVerifier, type ProposedAction } from './policy.js';

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  inputSchema: S;
  /** Human-only tools are mounted only when the server runs with role=human (a person's own client). */
  humanOnly?: boolean;
  handler: (input: z.infer<S>) => Promise<unknown>;
}

/** Keeps the input type of each handler bound to its own schema inside a heterogeneous list. */
function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export interface ToolContext {
  providers: Providers;
  approvals: ApprovalQueue;
  policy?: PolicyConfig;
  /** Trusted clock of the server process. policy_check passes its reading to the policy; without it external actions are denied. */
  clock?: () => Date;
  /** Evidence verifier over the instance's trusted records. Without it policy_check never returns allow for an L2 action. */
  verifier?: PolicyEvidenceVerifier;
  /** Identity of the caller as configured at startup: an agent id or a person's name. It scopes reads; it never decides. */
  caller: string;
  role: 'agent' | 'human';
  /** Approvers configured on this server (approvers.ts). Without it no decision can be authenticated: decisions are refused. */
  approvers?: ApproverRegistry;
  /** Read scopes per actor (access.ts). Without it every read of mail, files, jobs and approvals is refused. */
  access?: AccessScopes;
  /** Tenant of this instance, recorded on approval requests. */
  tenant?: string;
}

const Category = z.enum(['read', 'internal_note', 'draft', 'supplier_inquiry', 'supplier_followup', 'customer_quote', 'price', 'order', 'contract', 'new_counterparty', 'drawing_release', 'send_external']);
const Level = z.enum(['L0', 'L1', 'L2', 'L3']);
const Address = z.object({ address: z.string(), name: z.string().optional() });
const Attachment = z.object({ documentId: z.string(), revision: z.string(), sha256: z.string(), filename: z.string(), kind: z.enum(['drawing', 'document']) });
const DrawingCheck = z.object({ documentId: z.string(), revision: z.string(), check: z.string(), by: z.string(), at: z.string() });
const Token = z.object({
  approverId: z.string(), approvalId: z.string(), decision: z.enum(['approved', 'rejected', 'revoked']), bindingHash: z.string().nullable(),
  issuedAt: z.string(), expiresAt: z.string(), signature: z.string(),
});

/** An approval request is visible to the actor that filed it and to actors whose scope covers its job. */
function visible(ctx: ToolContext, v: ApprovalView): boolean {
  if (v.requestedBy === ctx.caller) return true;
  const scope = ctx.access?.scopeOf(ctx.caller);
  if (!scope) return false;
  return v.jobId !== undefined ? ctx.access!.canReadJob(ctx.caller, v.jobId) : scope.jobs === '*';
}

export function buildTools(ctx: ToolContext): ToolDef[] {
  const policy = ctx.policy ?? DEFAULT_POLICY;
  const scopes = (): AccessScopes => {
    if (!ctx.access) throw new Error('no access policy is configured on this server: reads are refused');
    ctx.access.require(ctx.caller);
    return ctx.access;
  };
  /** Verify a person's signed decision token for one request against the server's approver registry. */
  const authenticate = async (id: string, decision: DecisionKind, token: DecisionToken | undefined) => {
    if (!ctx.approvers) throw new Error('no approver registry is configured on this server: a decision cannot be authenticated');
    const request = await ctx.approvals.get(id);
    if (!request) throw new Error(`unknown approval ${id}`);
    const verdict = ctx.approvers.verify(token, {
      approvalId: id, decision, bindingHash: request.bindingHash ?? null,
      subject: { tenant: request.tenant, category: request.category, jobId: request.jobId, amount: request.amount },
    }, ctx.clock?.() ?? new Date());
    if (!verdict.ok) throw new Error(`decision refused: ${verdict.reason}`);
    return { request, approver: verdict.approver };
  };
  const tools: ToolDef[] = [
    defineTool({
      name: 'search_mail',
      description: 'Search company mailboxes (rfq@, office@, archiv@ or a person) by words; returns id, mailbox, from, subject, date, attachments and the linked job id. Only messages of jobs (or mailboxes) in the caller\'s scope.',
      inputSchema: z.object({ query: z.string(), mailbox: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
      handler: async (i) => {
        const access = scopes();
        return access.messages(ctx.caller, await ctx.providers.mail.searchMail(i.query, { mailbox: i.mailbox, limit: 500 })).slice(0, i.limit ?? 20);
      },
    }),
    defineTool({
      name: 'get_message',
      description: 'Read one mail message by id.',
      inputSchema: z.object({ id: z.string() }),
      handler: async (i) => {
        const access = scopes();
        const m = await ctx.providers.mail.getMessage(i.id);
        return m && access.canReadMessage(ctx.caller, m) ? m : null;
      },
    }),
    defineTool({
      name: 'search_files',
      description: 'Search the shared libraries (Jobs, Quotes, Drawings, Archive) by words, optionally inside one job; returns path, name, revision, date, size.',
      inputSchema: z.object({ query: z.string(), library: z.string().optional(), jobId: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
      handler: async (i) => {
        const access = scopes();
        return access.files(ctx.caller, await ctx.providers.files.searchFiles(i.query, { library: i.library, jobId: i.jobId, limit: 500 })).slice(0, i.limit ?? 20);
      },
    }),
    defineTool({
      name: 'get_job',
      description: 'Read one job record (DOP id) with its chain of RFQ_OUT, CN and PO children and the sourcing plan (where to order what).',
      inputSchema: z.object({ id: z.string() }),
      handler: async (i) => {
        const access = scopes();
        return access.canReadJob(ctx.caller, i.id) ? ctx.providers.records.getJob(i.id) : null;
      },
    }),
    defineTool({
      name: 'list_jobs',
      description: 'List job records, optionally by stage (inquiry, quoting, quoted, ordered, in_production, delivered, closed, lost).',
      inputSchema: z.object({ stage: z.enum(['inquiry', 'quoting', 'quoted', 'ordered', 'in_production', 'delivered', 'closed', 'lost']).optional(), limit: z.number().int().min(1).max(200).optional() }),
      handler: async (i) => {
        const access = scopes();
        return access.jobs(ctx.caller, await ctx.providers.records.listJobs({ stage: i.stage, limit: 1_000 })).slice(0, i.limit ?? 50);
      },
    }),
    defineTool({
      name: 'ledger_append',
      description: 'Append one handover line to the append-only ledger: when (YYYY-MM-DD HH:MM TZ), to, task, status (DONE, OPEN, PROBLEM, STOP), evidence. "from" is the configured caller.',
      inputSchema: z.object({ when: z.string(), to: z.string(), task: z.string(), status: z.enum(['DONE', 'OPEN', 'PROBLEM', 'STOP']), evidence: z.string() }),
      handler: (i) => ctx.providers.memory.appendLedger({ ...i, from: ctx.caller }),
    }),
    defineTool({
      name: 'ledger_tail',
      description: 'Read the last n ledger lines (default 20).',
      inputSchema: z.object({ n: z.number().int().min(1).max(200).optional() }),
      handler: (i) => ctx.providers.memory.readLedgerTail(i.n ?? 20),
    }),
    defineTool({
      name: 'state_of_build',
      description: 'Read the living "where are we" page of the company (workstreams, numbers, next actions, open decisions).',
      inputSchema: z.object({}),
      handler: () => ctx.providers.memory.readStatePage(),
    }),
    defineTool({
      name: 'policy_check',
      description: 'Ask the autonomy policy whether a proposed action is allow, ask or deny, with reasons. Workers call this before any external step, with the actual message as evidence: from, to, cc, bcc, subject, text, the attachment manifest, named drawing checks, template id and version, supervisor and whether the disclosure line is rendered.',
      inputSchema: z.object({
        category: Category, level: Level, external: z.boolean(),
        counterpartyInRegister: z.boolean().optional(), recipientKnown: z.boolean().optional(), templateApproved: z.boolean().optional(),
        statesOurPrice: z.boolean().optional(), uncertain: z.boolean().optional(), localTime: z.string().optional(),
        from: Address.optional(), to: z.array(Address).optional(), cc: z.array(Address).optional(), bcc: z.array(Address).optional(),
        subject: z.string().optional(), text: z.string().optional(),
        attachments: z.array(Attachment).optional(), drawingChecks: z.array(DrawingCheck).optional(),
        templateId: z.string().optional(), templateVersion: z.string().optional(),
        supervisor: z.string().optional(), disclosureRendered: z.boolean().optional(),
      }),
      handler: async (i) => decide(i as unknown as ProposedAction, policy, { now: ctx.clock?.(), verifier: ctx.verifier }),
    }),
    defineTool({
      name: 'approval_request',
      description: 'File a request for a human decision (used after policy_check returns ask), optionally for one job in the caller\'s scope and with the amount it commits. Returns the request id; the worker stops until a person decides. A payload is the worker\'s note: it never authorizes a send.',
      inputSchema: z.object({
        category: Category, summary: z.string().min(3), payload: z.record(z.string(), z.unknown()).optional(), reasons: z.array(z.string()).optional(),
        jobId: z.string().optional(), amount: z.number().nonnegative().optional(),
      }),
      handler: async (i) => {
        if (i.jobId !== undefined && !ctx.access?.canReadJob(ctx.caller, i.jobId)) throw new Error(`caller ${ctx.caller} has no access to job ${i.jobId}`);
        return ctx.approvals.request({
          requestedBy: ctx.caller, category: i.category, summary: i.summary, payload: i.payload ?? {}, reasons: i.reasons ?? [],
          ...(ctx.tenant ? { tenant: ctx.tenant } : {}), ...(i.jobId !== undefined ? { jobId: i.jobId } : {}), ...(i.amount !== undefined ? { amount: i.amount } : {}),
        });
      },
    }),
    defineTool({
      name: 'approval_list',
      description: 'List approval requests visible to the caller (its own, and those of jobs in its scope), optionally by status (pending, approved, rejected, revoked).',
      inputSchema: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'revoked']).optional() }),
      handler: async (i) => {
        if (!ctx.access) throw new Error('no access policy is configured on this server: reads are refused');
        return (await ctx.approvals.list(i.status)).filter((v) => visible(ctx, v));
      },
    }),
    defineTool({
      name: 'approval_decide',
      description: 'Decide one pending approval (approved or rejected) with an optional note and the decision token signed by a configured approver over the request id, the decision and the binding hash. Human only: mounted only in a person\'s own client; the token, not the caller name, establishes who decides.',
      inputSchema: z.object({ id: z.string(), decision: z.enum(['approved', 'rejected']), note: z.string().optional(), token: Token.optional() }),
      humanOnly: true,
      handler: async (i) => {
        const { request, approver } = await authenticate(i.id, i.decision, i.token as DecisionToken | undefined);
        return ctx.approvals.decide(i.id, i.decision, approver.name, i.note, { approverId: approver.id, ...(request.bindingHash !== undefined ? { bindingHash: request.bindingHash } : {}) });
      },
    }),
    defineTool({
      name: 'approval_revoke',
      description: 'Revoke an approved request before it is used, with the decision token signed by a configured approver. Human only.',
      inputSchema: z.object({ id: z.string(), note: z.string().optional(), token: Token.optional() }),
      humanOnly: true,
      handler: async (i) => {
        const { approver } = await authenticate(i.id, 'revoked', i.token as DecisionToken | undefined);
        return ctx.approvals.revoke(i.id, approver.name, i.note, { approverId: approver.id });
      },
    }),
  ];
  return tools.filter((t) => !t.humanOnly || ctx.role === 'human');
}

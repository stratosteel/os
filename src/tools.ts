/**
 * Layer 5, the access door: tool definitions independent of the transport.
 * Every AI (chat assistant, coding agent, worker) reaches mail, files, records and memory only through these
 * tools, so the same policy and the same records apply whatever model or vendor is on the other side.
 * `server.ts` registers them with the MCP SDK; tests call the handlers directly.
 */
import * as z from 'zod/v4';
import type { Providers } from './providers.js';
import { ApprovalQueue } from './approvals.js';
import { decide, DEFAULT_POLICY, type PolicyConfig, type ProposedAction } from './policy.js';

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
  /** Identity of the caller as configured at startup: an agent id or a person's name. */
  caller: string;
  role: 'agent' | 'human';
}

const Category = z.enum(['read', 'internal_note', 'draft', 'supplier_inquiry', 'supplier_followup', 'customer_quote', 'price', 'order', 'contract', 'new_counterparty', 'drawing_release', 'send_external']);
const Level = z.enum(['L0', 'L1', 'L2', 'L3']);

export function buildTools(ctx: ToolContext): ToolDef[] {
  const policy = ctx.policy ?? DEFAULT_POLICY;
  const tools: ToolDef[] = [
    defineTool({
      name: 'search_mail',
      description: 'Search company mailboxes (rfq@, office@, archiv@ or a person) by words; returns id, mailbox, from, subject, date, attachments and the linked job id.',
      inputSchema: z.object({ query: z.string(), mailbox: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
      handler: (i) => ctx.providers.mail.searchMail(i.query, { mailbox: i.mailbox, limit: i.limit }),
    }),
    defineTool({
      name: 'get_message',
      description: 'Read one mail message by id.',
      inputSchema: z.object({ id: z.string() }),
      handler: (i) => ctx.providers.mail.getMessage(i.id),
    }),
    defineTool({
      name: 'search_files',
      description: 'Search the shared libraries (Jobs, Quotes, Drawings, Archive) by words, optionally inside one job; returns path, name, revision, date, size.',
      inputSchema: z.object({ query: z.string(), library: z.string().optional(), jobId: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
      handler: (i) => ctx.providers.files.searchFiles(i.query, { library: i.library, jobId: i.jobId, limit: i.limit }),
    }),
    defineTool({
      name: 'get_job',
      description: 'Read one job record (DOP id) with its chain of RFQ_OUT, CN and PO children and the sourcing plan (where to order what).',
      inputSchema: z.object({ id: z.string() }),
      handler: (i) => ctx.providers.records.getJob(i.id),
    }),
    defineTool({
      name: 'list_jobs',
      description: 'List job records, optionally by stage (inquiry, quoting, quoted, ordered, in_production, delivered, closed, lost).',
      inputSchema: z.object({ stage: z.enum(['inquiry', 'quoting', 'quoted', 'ordered', 'in_production', 'delivered', 'closed', 'lost']).optional(), limit: z.number().int().min(1).max(200).optional() }),
      handler: (i) => ctx.providers.records.listJobs({ stage: i.stage, limit: i.limit }),
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
      description: 'Ask the autonomy policy whether a proposed action is allow, ask or deny, with reasons. Workers call this before any external step.',
      inputSchema: z.object({
        category: Category, level: Level, external: z.boolean(),
        counterpartyInRegister: z.boolean().optional(), recipientKnown: z.boolean().optional(), templateApproved: z.boolean().optional(),
        statesOurPrice: z.boolean().optional(), drawingChecks: z.number().int().min(0).optional(), text: z.string().optional(), localTime: z.string().optional(),
      }),
      handler: async (i) => decide(i as unknown as ProposedAction, policy),
    }),
    defineTool({
      name: 'approval_request',
      description: 'File a request for a human decision (used after policy_check returns ask). Returns the request id; the worker stops until a person decides.',
      inputSchema: z.object({ category: Category, summary: z.string().min(3), payload: z.record(z.string(), z.unknown()).optional(), reasons: z.array(z.string()).optional() }),
      handler: (i) => ctx.approvals.request({ requestedBy: ctx.caller, category: i.category, summary: i.summary, payload: i.payload ?? {}, reasons: i.reasons ?? [] }),
    }),
    defineTool({
      name: 'approval_list',
      description: 'List approval requests, optionally by status (pending, approved, rejected).',
      inputSchema: z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() }),
      handler: (i) => ctx.approvals.list(i.status),
    }),
    defineTool({
      name: 'approval_decide',
      description: 'Decide one pending approval (approved or rejected) with an optional note. Human only: mounted only in a person\'s own client.',
      inputSchema: z.object({ id: z.string(), decision: z.enum(['approved', 'rejected']), note: z.string().optional() }),
      humanOnly: true,
      handler: (i) => ctx.approvals.decide(i.id, i.decision, ctx.caller, i.note),
    }),
  ];
  return tools.filter((t) => !t.humanOnly || ctx.role === 'human');
}

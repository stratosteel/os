/**
 * Tools over FABRIX's /api/v1 verbs. They are mounted only when layer 2 is FABRIX
 * (providers.fabrix). The worker still calls policy_check before any external step; FABRIX
 * enforces its own gates again (an approved approval for a number that goes out, a counterparty
 * that is approved, a drawing that passed its checks, a source for every supplier answer).
 *
 * Deliberately absent: deciding an approval and approving a counterparty. A person does those in
 * their own client; FABRIX refuses them for a worker account as well.
 */
import * as z from 'zod/v4';
import type { FabrixGateway } from './providers.js';
import type { ToolDef } from './tools.js';

type Define = <S extends z.ZodObject>(def: ToolDef<S>) => ToolDef;

const id = z.string().min(1);

export function fabrixTools(g: FabrixGateway, define: Define): ToolDef[] {
  const read = (name: string, verb: string, description: string, schema: z.ZodObject) =>
    define({
      name, description, inputSchema: schema,
      handler: (i: Record<string, unknown>) => g.read(verb, i as Record<string, string | number | undefined>),
    } as ToolDef<z.ZodObject>);
  const write = (name: string, verb: string, description: string, schema: z.ZodObject) =>
    define({
      name, description: `${description} (Idempotency-Key is generated; pass idempotency_key to retry a call safely.)`,
      inputSchema: schema.extend({ idempotency_key: z.string().min(8).max(200).optional(), on_behalf_of: z.string().optional() }),
      handler: (i: Record<string, unknown>) => {
        const { idempotency_key, ...rest } = i as { idempotency_key?: string } & Record<string, unknown>;
        return g.write(verb, rest, idempotency_key);
      },
    } as ToolDef<z.ZodObject>);

  return [
    read('fabrix_list_open_items', 'list_open_items', 'Everything that waits for somebody: unacknowledged enquiries, follow-ups due, approvals, overdue invoices, invites without answer, incomplete rounds, mail to review, customer material.', z.object({})),
    read('fabrix_get_document', 'get_document', 'A document with its lines, chain, audit and every revision.', z.object({ id })),
    read('fabrix_get_rfq', 'get_rfq', 'A received enquiry with its attachments and hashes.', z.object({ id })),
    read('fabrix_get_sourcing_matrix', 'get_sourcing_matrix', 'Lines x suppliers of one sourcing round.', z.object({ document_id: id, round_id: id })),
    read('fabrix_get_counterparty', 'get_counterparty', 'A partner with screenings, parent company, contacts and NDAs.', z.object({ id })),
    write('fabrix_register_document_from_rfq', 'register_document_from_rfq', 'Register a received enquiry as a DOP with a job and lines.', z.object({
      intake_id: id, partner_id: id, job_name: z.string().min(1),
      lines: z.array(z.object({ description: z.string(), qty: z.number(), unit: z.string().optional(), sku: z.string().optional() })).min(1),
    })),
    write('fabrix_acknowledge_rfq', 'acknowledge_rfq', 'Prepare the acknowledgement text for a person to send from Mail.app. Sends nothing.', z.object({ intake_id: id })),
    write('fabrix_create_sourcing_round', 'create_sourcing_round', 'Create a round for one package: RFQ_OUT drafts for the chosen suppliers carrying every line.', z.object({
      document_id: id, package: z.string().min(1), reply_by: z.string().optional(), supplier_ids: z.array(id).min(1),
      excluded_lines: z.array(z.object({ line_id: id, reason: z.string().min(1) })).optional(),
    })),
    write('fabrix_invite_supplier', 'invite_supplier', 'Add a supplier to an open round.', z.object({ round_id: id, supplier_id: id })),
    write('fabrix_record_supplier_response', 'record_supplier_response', 'Record a supplier answer per line. A file id or a Message-ID is required.', z.object({
      invite_id: id, source_message_id: z.string().optional(), file_id: z.string().optional(),
      currency: z.string().optional(), incoterms: z.string().optional(), payment_terms: z.string().optional(), valid_until: z.string().optional(),
      lines: z.array(z.object({
        line_id: id, can_supply: z.boolean().optional(), unit_price: z.number().optional(), qty_offered: z.number().optional(),
        lead_time_weeks: z.number().optional(), deviates: z.boolean().optional(), deviation_note: z.string().optional(),
      })).min(1),
    })),
    write('fabrix_record_decline', 'record_decline', 'A supplier declined; "if not you, who" is kept as a tip.', z.object({ invite_id: id, referred_to: z.string().optional() })),
    write('fabrix_schedule_followup', 'schedule_followup', 'Record that a supplier was chased (day 3, then day 6).', z.object({ invite_id: id })),
    write('fabrix_propose_choice', 'propose_choice', 'Propose a supplier for one line; not the cheapest needs a reason.', z.object({ round_id: id, line_id: id, invite_id: id, reason: z.string().optional() })),
    write('fabrix_request_approval', 'request_approval', 'Ask a person to approve THIS version of a document (revision and content hash).', z.object({
      document_id: id, kind: z.enum(['send', 'cancel', 'credit_note', 'cert_exception']), note: z.string().optional(), payload: z.record(z.string(), z.unknown()).optional(),
    })),
    write('fabrix_issue_document', 'issue_document', 'Mark a document sent. Needs an approved approval of exactly this content.', z.object({ document_id: id })),
    write('fabrix_cancel_document', 'cancel_document', 'Cancel a document with a reason (rules by family; an issued invoice is never cancelled).', z.object({ document_id: id, reason: z.string().min(3) })),
    write('fabrix_create_offer_revision', 'create_offer_revision', 'Make rev. n+1 of a sent offer, order or enquiry as a draft with the same number.', z.object({ document_id: id, reason: z.string().min(3) })),
    write('fabrix_screen_counterparty', 'screen_counterparty', 'Record a screening with identifiers and evidence; a result that is not clear blocks the counterparty.', z.object({
      partner_id: id, scope: z.enum(['company', 'parent']), entity_name: z.string().min(1), identifiers: z.record(z.string(), z.string()),
      lists_checked: z.array(z.string()).min(1), result: z.enum(['clear', 'possible_match', 'match']), evidence_url: z.string().optional(), note: z.string().optional(),
    })),
    write('fabrix_record_payment', 'record_payment', 'Record a payment received; only from a source (bank reference required).', z.object({
      invoice_id: id, amount: z.number(), paid_at: z.string(), bank_ref: z.string().min(1), variable_symbol: z.string().optional(),
    })),
  ];
}

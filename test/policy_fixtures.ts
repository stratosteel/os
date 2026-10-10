/**
 * Shared fixtures for the policy tests. Invented names, example.com addresses and made-up hashes only.
 */
import { DEFAULT_POLICY, type AttachmentEvidence, type DrawingCheckEvidence, type PolicyConfig, type PolicyContext, type ProposedAction } from '../src/policy.js';

/** A configured instance policy: the template defaults plus a denylist of invented names. */
export const CONFIG: PolicyConfig = { ...DEFAULT_POLICY, confidentialNames: ['Partner Alpha Works', 'Beta Foundry'] };

/**
 * A trusted clock reading given as Europe/Bratislava wall time. Summer-time dates only (UTC+2, 2026-03-29 to 2026-10-24);
 * the DST tests give UTC instants explicitly.
 */
export function bratislava(hhmm: string, date = '2026-10-07'): Date {
  if (date < '2026-03-29' || date > '2026-10-24') throw new Error(`bratislava() covers summer-time dates only, got ${date}`);
  return new Date(`${date}T${hhmm}:00+02:00`);
}

/** What the server passes to the policy: its own clock reading at 10:00 local. */
export const TRUSTED: PolicyContext = { now: bratislava('10:00') };

/** A drawing exactly as it leaves: stored document, immutable revision and the hash of its bytes. */
export const DRAWING: AttachmentEvidence = { documentId: 'doc-0001', revision: '3', sha256: '9b1f'.repeat(16), filename: 'hall_40x18_rev3.pdf', kind: 'drawing' };

/** A plain document that is not a drawing. */
export const SPEC: AttachmentEvidence = { documentId: 'doc-0002', revision: '1', sha256: '4c7e'.repeat(16), filename: 'rfq_scope_rev1.pdf', kind: 'document' };

/** Three named checks on revision 3 of the drawing, each by a named person or scanning agent at a recorded time. */
export const CHECKS: DrawingCheckEvidence[] = [
  { documentId: 'doc-0001', revision: '3', check: 'text-scan', by: 'scan-agent-1', at: '2026-10-07T07:10:00Z' },
  { documentId: 'doc-0001', revision: '3', check: 'graphics-scan', by: 'scan-agent-2', at: '2026-10-07T07:12:00Z' },
  { documentId: 'doc-0001', revision: '3', check: 'title-block-review', by: 'M. Example', at: '2026-10-07T07:30:00Z' },
];

/** An L2 supplier inquiry carrying every piece of evidence the autonomous path asks for. */
export const EVIDENCED: ProposedAction = {
  category: 'supplier_inquiry',
  level: 'L2',
  external: true,
  counterpartyInRegister: true,
  recipientKnown: true,
  templateApproved: true,
  from: { address: 'rfq-worker@example.com', name: 'RFQ desk' },
  to: [{ address: 'offers@example.com', name: 'Offers desk' }],
  subject: 'RFQ-2610-001 steel supply S355J2',
  text: 'Please quote the attached scope by 2026-10-14. This message was prepared and sent by an AI system of Template Company; a named person is responsible and can be reached at rfq@example.com.',
  attachments: [SPEC],
  templateId: 'tpl-rfq-supplier',
  templateVersion: '3',
  supervisor: 'M. Example',
  disclosureRendered: true,
};

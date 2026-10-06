/**
 * Layer 6, human gates: the owner's autonomy policy as code.
 *
 * Source of the rules (canon, stratosteel/stratosteel):
 *  - STRATOSTEEL_OS_ARCHITECTURE.md section 4 (owner statement 2026-10-06 evening: AI operates and clicks,
 *    people approve templates and numbers, never operations) and MS-D04 in the Monday Start master.
 *  - Standing constraints: no external sending in quiet hours; drawings leave only after 3 checks;
 *    confidential names never appear externally; every autonomous external message discloses the AI.
 *
 * The policy is pure: no I/O, no clock reads. The caller passes the local time. Tests pin every rule.
 */

export type AutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3';

export type ActionCategory =
  | 'read'                 // searching mail, files, records
  | 'internal_note'        // ledger line, internal status, internal chat
  | 'draft'                // a draft for a person to release
  | 'supplier_inquiry'     // request for quotation to a supplier in the approved register
  | 'supplier_followup'    // follow-up on an open supplier inquiry
  | 'customer_quote'       // a quote or offer to a customer
  | 'price'                // any message that states our price
  | 'order'                // placing or confirming an order
  | 'contract'             // contract, NDA, terms
  | 'new_counterparty'     // first contact with a supplier or customer not in the register
  | 'drawing_release'      // sending a drawing to a third party
  | 'send_external';       // any other external message

export type Decision = 'allow' | 'ask' | 'deny';

export interface ProposedAction {
  category: ActionCategory;
  /** Autonomy level granted to the worker for this workflow (L0 observe, L1 draft, L2 act in approved scope, L3 free). */
  level: AutonomyLevel;
  /** Message leaves the company (e-mail, portal, chat with an outside party). */
  external: boolean;
  /** Counterparty is in the approved supplier or customer register. */
  counterpartyInRegister?: boolean;
  /** Recipient address is known in the register for that counterparty. */
  recipientKnown?: boolean;
  /** The template used was approved by a person. */
  templateApproved?: boolean;
  /** The message states our own price or a number a person has not approved. */
  statesOurPrice?: boolean;
  /** Number of completed checks on an attached drawing (3 required). */
  drawingChecks?: number;
  /** Outbound text, scanned against the confidential-name denylist. */
  text?: string;
  /** Local time of the action in the company timezone, 'HH:MM'. */
  localTime?: string;
}

export interface PolicyConfig {
  /** Names that must never appear in external text (partners, suppliers, customers). The template ships empty. */
  confidentialNames: string[];
  /** Quiet hours for external sending, local time, inclusive start, exclusive end. */
  quietHours: { start: string; end: string };
  /** Minimum completed checks before a drawing leaves the company. */
  drawingChecksRequired: number;
  /** Categories that always need a person, whatever the level (owner: prices, orders, contracts, new counterparties). */
  alwaysAsk: ActionCategory[];
  /** Categories a worker may do alone at L2 inside approved templates and the register. */
  l2Autonomous: ActionCategory[];
}

export const DEFAULT_POLICY: PolicyConfig = {
  confidentialNames: [],
  quietHours: { start: '00:00', end: '06:00' },
  drawingChecksRequired: 3,
  alwaysAsk: ['customer_quote', 'price', 'order', 'contract', 'new_counterparty'],
  l2Autonomous: ['supplier_inquiry', 'supplier_followup'],
};

export interface PolicyResult {
  decision: Decision;
  reasons: string[];
  /** Every autonomous external message must disclose that it was produced by an AI system (Art. 50 AI Act). */
  disclosureRequired: boolean;
}

const LEVEL_RANK: Record<AutonomyLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

function minutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`bad time ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function inQuietHours(localTime: string, quiet: PolicyConfig['quietHours']): boolean {
  const t = minutes(localTime);
  const s = minutes(quiet.start);
  const e = minutes(quiet.end);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

export function findConfidentialNames(text: string, names: string[]): string[] {
  const hay = text.toLowerCase();
  return names.filter((n) => n.trim() && hay.includes(n.trim().toLowerCase()));
}

export function decide(action: ProposedAction, config: PolicyConfig = DEFAULT_POLICY): PolicyResult {
  const reasons: string[] = [];
  const rank = LEVEL_RANK[action.level];

  // 1. Internal work: reads always; notes and drafts from L1.
  if (!action.external) {
    if (action.category === 'read') return { decision: 'allow', reasons: ['read is always allowed'], disclosureRequired: false };
    if (rank >= 1 && (action.category === 'internal_note' || action.category === 'draft')) {
      return { decision: 'allow', reasons: ['internal work at L1 or above'], disclosureRequired: false };
    }
    if (rank === 0) return { decision: 'ask', reasons: ['L0 observes only'], disclosureRequired: false };
    return { decision: 'allow', reasons: ['internal action'], disclosureRequired: false };
  }

  // 2. Hard denials for anything external.
  if (action.text) {
    const hits = findConfidentialNames(action.text, config.confidentialNames);
    if (hits.length) {
      return { decision: 'deny', reasons: [`confidential name in external text: ${hits.join(', ')}`], disclosureRequired: true };
    }
  }
  if (action.localTime && inQuietHours(action.localTime, config.quietHours)) {
    return { decision: 'deny', reasons: [`external sending in quiet hours ${config.quietHours.start}-${config.quietHours.end}`], disclosureRequired: true };
  }
  if (action.category === 'drawing_release' || (action.drawingChecks !== undefined && action.drawingChecks < config.drawingChecksRequired)) {
    const checks = action.drawingChecks ?? 0;
    if (checks < config.drawingChecksRequired) {
      return { decision: 'deny', reasons: [`drawing has ${checks} of ${config.drawingChecksRequired} checks`], disclosureRequired: true };
    }
  }

  // 3. Always a person: prices, quotes, orders, contracts, new counterparties, unknown recipients.
  if (config.alwaysAsk.includes(action.category)) reasons.push(`${action.category} always needs a person`);
  if (action.statesOurPrice) reasons.push('message states our price');
  if (action.counterpartyInRegister === false) reasons.push('counterparty not in the register');
  if (action.recipientKnown === false) reasons.push('recipient unknown');
  if (reasons.length) return { decision: 'ask', reasons, disclosureRequired: true };

  // 4. Level gates for external action.
  if (rank < 2) return { decision: 'ask', reasons: [`level ${action.level} may not send externally`], disclosureRequired: true };
  if (rank === 2) {
    if (!config.l2Autonomous.includes(action.category)) {
      return { decision: 'ask', reasons: [`${action.category} is outside the L2 autonomous scope`], disclosureRequired: true };
    }
    if (!action.templateApproved) return { decision: 'ask', reasons: ['template not approved by a person'], disclosureRequired: true };
    if (!action.counterpartyInRegister) return { decision: 'ask', reasons: ['counterparty register not confirmed'], disclosureRequired: true };
    if (!action.recipientKnown) return { decision: 'ask', reasons: ['recipient not confirmed in the register'], disclosureRequired: true };
    if (action.drawingChecks !== undefined && action.drawingChecks < config.drawingChecksRequired) {
      return { decision: 'deny', reasons: ['drawing checks incomplete'], disclosureRequired: true };
    }
    return { decision: 'allow', reasons: ['L2: approved template, registered counterparty and recipient'], disclosureRequired: true };
  }
  // L3: free external action is not granted before day 180 and never without an owner rule change (MS-D04).
  return { decision: 'ask', reasons: ['L3 external autonomy is not enabled by the owner'], disclosureRequired: true };
}

/** The disclosure line every autonomous external message must carry (wording to be confirmed by the lawyer). */
export const DISCLOSURE_LINE_EN = 'This message was prepared and sent by an AI system of {company}; a named person is responsible and can be reached at {contact}.';

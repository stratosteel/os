/**
 * Layer 6, human gates: the owner's autonomy policy as code.
 *
 * Source of the rules (canon, stratosteel/stratosteel):
 *  - STRATOSTEEL_OS_ARCHITECTURE.md section 4 (owner statement 2026-10-06 evening: AI operates and clicks,
 *    people approve templates and numbers, never operations) and MS-D04 in the Monday Start master.
 *  - Standing constraints: no external sending in quiet hours; drawings leave only after 3 checks;
 *    confidential names never appear externally; every autonomous external message discloses the AI.
 *
 * The policy is pure: no I/O, no clock reads. The caller (the server, never the worker) passes its own trusted clock
 * reading in `PolicyContext.now`; the policy reads it in the configured IANA timezone and fails closed when the reading
 * or the clock configuration is missing or invalid. Tests pin every rule.
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
  /**
   * The worker's own reading of the local time, 'HH:MM'. A claim, never the clock: the trusted reading in
   * `PolicyContext.now` decides. An unparseable value or a value inside quiet hours denies; it never makes an action pass.
   */
  localTime?: string;
}

export interface PolicyConfig {
  /** Names that must never appear in external text (partners, suppliers, customers). The template ships empty. */
  confidentialNames: string[];
  /** IANA timezone of the company clock (for example 'Europe/Bratislava'); quiet hours are read in this zone. */
  timezone: string;
  /** Quiet hours for external sending, local time in `timezone`, inclusive start, exclusive end. */
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
  timezone: 'Europe/Bratislava',
  // 00:00 is the owner's rule (no external sending after midnight). The 06:00 resume time is a configurable
  // implementation choice of this template, not a separately verified owner instruction; an instance records its own.
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

/** What the caller supplies at decision time. It comes from the server, never from the worker. */
export interface PolicyContext {
  /** Trusted clock reading taken by the caller at the moment of the decision. Without it every external action is denied. */
  now?: Date;
}

/** The state of a person's decision on an approval request, as the approval queue reports it. */
export interface ApprovalState {
  status: 'pending' | 'approved' | 'rejected';
}

const LEVEL_RANK: Record<AutonomyLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

/** Minutes after midnight of an 'H:MM' or 'HH:MM' time; throws on anything else, including out-of-range values like 99:99. */
function minutes(hhmm: string): number {
  const m = typeof hhmm === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(hhmm) : null;
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`bad time ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function isClockTime(value: unknown): value is string {
  try {
    minutes(value as string);
    return true;
  } catch {
    return false;
  }
}

/** An IANA zone name as the runtime knows it. Offsets such as '+02:00' are refused: they ignore summer time. */
function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z]/.test(value.trim())) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}

/** Local date and time of an instant in an IANA timezone ('YYYY-MM-DD', 'HH:MM'), DST included. Pure: reads no clock. */
export function localClock(instant: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

/** Denials from the clock rules: configuration, the trusted reading, quiet hours, and the worker's own time claim. */
function clockDenials(action: ProposedAction, config: PolicyConfig, now: Date | undefined): string[] {
  const reasons: string[] = [];
  const quiet = config.quietHours;
  const zoneOk = isTimeZone(config.timezone);
  const quietOk = isClockTime(quiet?.start) && isClockTime(quiet?.end);
  if (!zoneOk) reasons.push(`clock configuration invalid: timezone ${JSON.stringify(config.timezone ?? null)} is not an IANA time zone`);
  if (!quietOk) reasons.push('quiet hours configuration invalid: start and end must be HH:MM times between 00:00 and 23:59');
  if (now === undefined) {
    reasons.push('no trusted clock: the caller must pass its own clock reading; a worker-supplied localTime is never enough');
  } else if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    reasons.push('trusted clock reading is invalid');
  } else if (zoneOk && quietOk) {
    const local = localClock(now, config.timezone.trim());
    if (inQuietHours(local.time, quiet)) {
      reasons.push(`external sending in quiet hours ${quiet.start}-${quiet.end} ${config.timezone.trim()} (trusted clock ${local.date} ${local.time})`);
    }
  }
  if (action.localTime !== undefined) {
    if (!isClockTime(action.localTime)) reasons.push(`worker-supplied local time ${JSON.stringify(action.localTime)} is not a valid HH:MM time`);
    else if (quietOk && inQuietHours(action.localTime, quiet)) reasons.push(`worker-supplied local time ${action.localTime} is in quiet hours`);
  }
  return reasons;
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

export function decide(action: ProposedAction, config: PolicyConfig = DEFAULT_POLICY, context: PolicyContext = {}): PolicyResult {
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

  // 2. Hard denials for anything external, collected together; no later approval overrides them.
  const denials: string[] = [];
  if (action.text) {
    const hits = findConfidentialNames(action.text, config.confidentialNames);
    if (hits.length) denials.push(`confidential name in external text: ${hits.join(', ')}`);
  }
  denials.push(...clockDenials(action, config, context.now));
  if (action.category === 'drawing_release' || (action.drawingChecks !== undefined && action.drawingChecks < config.drawingChecksRequired)) {
    const checks = action.drawingChecks ?? 0;
    if (checks < config.drawingChecksRequired) denials.push(`drawing has ${checks} of ${config.drawingChecksRequired} checks`);
  }
  if (denials.length) return { decision: 'deny', reasons: denials, disclosureRequired: true };

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

/**
 * Dispatch-time recheck at the side-effect boundary: the policy runs again with the trusted clock reading taken at the
 * moment of sending. A deny always wins: neither an earlier policy_check nor a person's approval carries a send into
 * quiet hours (approved at 23:50, dispatched at 00:10: denied). An ask becomes allow only with an approved decision;
 * a rejected decision denies; a pending one stays ask. Binding the approval to the exact message revision is A11 (gate G3).
 */
export function recheckAtDispatch(action: ProposedAction, approval: ApprovalState | undefined, config: PolicyConfig = DEFAULT_POLICY, context: PolicyContext = {}): PolicyResult {
  const r = decide(action, config, context);
  if (r.decision === 'deny') return { ...r, reasons: [...r.reasons, 'rechecked at dispatch: an earlier allow or approval does not override a deny'] };
  if (approval?.status === 'rejected') return { decision: 'deny', reasons: ['rejected by a person'], disclosureRequired: r.disclosureRequired };
  if (r.decision === 'allow' || approval?.status !== 'approved') return r;
  return { decision: 'allow', reasons: [...r.reasons.map((x) => `asked: ${x}`), 'approved by a person; rechecked at dispatch'], disclosureRequired: r.disclosureRequired };
}

/** The disclosure line every autonomous external message must carry (wording to be confirmed by the lawyer). */
export const DISCLOSURE_LINE_EN = 'This message was prepared and sent by an AI system of {company}; a named person is responsible and can be reached at {contact}.';

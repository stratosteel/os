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

/** A mail address as it appears in the outgoing message. */
export interface MessageAddress {
  address: string;
  /** Display name every recipient sees; scanned for confidential names. */
  name?: string;
}

/** One file exactly as it leaves: the stored document, its immutable revision and the hash of the bytes. */
export interface AttachmentEvidence {
  documentId: string;
  /** Immutable revision of the stored document. */
  revision: string;
  /** SHA-256 of the exact bytes that leave, 64 hex characters. */
  sha256: string;
  /** File name the recipient sees; scanned for confidential names. */
  filename: string;
  /** 'document' states that the file is not a drawing; anything else is treated as a drawing. */
  kind: 'drawing' | 'document';
}

/** One completed drawing check: which check, by whom, when, on which document revision. */
export interface DrawingCheckEvidence {
  documentId: string;
  revision: string;
  /** Name of the check, for example 'text-scan', 'graphics-scan' or 'title-block-review'. */
  check: string;
  /** Named person or named scanning agent that did the check. */
  by: string;
  /** ISO 8601 time the check was completed. */
  at: string;
}

export interface ProposedAction {
  category: ActionCategory;
  /** Autonomy level granted to the worker for this workflow (L0 observe, L1 draft, L2 act in approved scope, L3 free). */
  level: AutonomyLevel;
  /** Message leaves the company (e-mail, portal, chat with an outside party). Categories in EXTERNAL_CATEGORIES are external whatever this says. */
  external: boolean;
  // Worker claims. A false claim makes the decision stricter; a true claim grants nothing: the evidence verifier decides.
  /** Claim: the counterparty is in the approved supplier or customer register. */
  counterpartyInRegister?: boolean;
  /** Claim: the recipient address is known in the register for that counterparty. */
  recipientKnown?: boolean;
  /** Claim: the template used was approved by a person. */
  templateApproved?: boolean;
  /** The message states our own price or a number a person has not approved. */
  statesOurPrice?: boolean;
  /** The worker is not sure how to classify the action (category, recipient, content): a person decides. */
  uncertain?: boolean;
  /**
   * The worker's own reading of the local time, 'HH:MM'. A claim, never the clock: the trusted reading in
   * `PolicyContext.now` decides. An unparseable value or a value inside quiet hours denies; it never makes an action pass.
   */
  localTime?: string;

  // Evidence: the actual outgoing message and the exact files, as they will leave.
  /** Sending identity exactly as it appears in From. */
  from?: MessageAddress;
  /** Actual recipients; display names are scanned for confidential names. */
  to?: MessageAddress[];
  cc?: MessageAddress[];
  bcc?: MessageAddress[];
  /** Subject line, scanned for confidential names. */
  subject?: string;
  /** Outbound body text, scanned for confidential names. */
  text?: string;
  /** Manifest of the exact files that leave with the message. */
  attachments?: AttachmentEvidence[];
  /** Completed drawing checks, each named, by whom and when, on one document revision. A count is not evidence. */
  drawingChecks?: DrawingCheckEvidence[];
  /** Template the message was rendered from, and its revision. */
  templateId?: string;
  templateVersion?: string;
  /** Named person responsible for the workflow, the one the disclosure line names. */
  supervisor?: string;
  /** The approved disclosure line is in the rendered outgoing message; required for an autonomous external allow. */
  disclosureRendered?: boolean;
}

export interface PolicyConfig {
  /**
   * Names that must never appear in external text (partners, suppliers, customers). The template ships it unset: an
   * instance lists its names, or sets an empty list together with `allowEmptyDenylist: true`. Unset, or empty without
   * that flag, is a configuration error that denies every external action.
   */
  confidentialNames?: string[];
  /** Accept an explicitly empty `confidentialNames` list. */
  allowEmptyDenylist?: boolean;
  /** IANA timezone of the company clock (for example 'Europe/Bratislava'); quiet hours are read in this zone. */
  timezone: string;
  /** Quiet hours for external sending, local time in `timezone`, inclusive start, exclusive end. */
  quietHours: { start: string; end: string };
  /** Minimum distinct named checks on a drawing's exact revision before it leaves the company (whole number, at least 1). */
  drawingChecksRequired: number;
  /** Categories that always need a person, whatever the level (owner: prices, orders, contracts, new counterparties). */
  alwaysAsk: ActionCategory[];
  /** Categories a worker may do alone at L2 inside approved templates and the register. */
  l2Autonomous: ActionCategory[];
}

export const DEFAULT_POLICY: PolicyConfig = {
  // confidentialNames is left unset on purpose: each instance configures its own denylist.
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

/**
 * Checks of the worker's evidence against trusted records that the caller has already loaded: approved template
 * revisions, the counterparty register, sending identities, the document store and drawing-check records. The policy
 * calls these synchronous checks with plain data and reads nothing itself. Without a verifier no L2 action is allowed.
 */
export interface PolicyEvidenceVerifier {
  /** This exact template revision exists and a person approved it. */
  templateApproved(templateId: string, templateVersion: string): boolean;
  /** The address is a registered recipient of a counterparty in the approved register. */
  recipientInRegister(address: string): boolean;
  /** The address is a sending identity this worker may use: a service mailbox, never a person's own mailbox. */
  senderAuthorized(address: string): boolean;
  /** The document store holds this immutable revision with exactly these bytes (sha256), this file name and kind. */
  attachmentMatches(attachment: AttachmentEvidence): boolean;
  /** This named check is on record for this document revision, by this person, at this time. */
  drawingCheckRecorded(check: DrawingCheckEvidence): boolean;
}

/** What the caller supplies at decision time. It comes from the server, never from the worker. */
export interface PolicyContext {
  /** Trusted clock reading taken by the caller at the moment of the decision. Without it every external action is denied. */
  now?: Date;
  /** Evidence verifier over the instance's trusted records. Without it an L2 action asks, never allows. */
  verifier?: PolicyEvidenceVerifier;
}

/** The state of a person's decision on an approval request, as the approval queue reports it. */
export interface ApprovalState {
  status: 'pending' | 'approved' | 'rejected';
}

const LEVEL_RANK: Record<AutonomyLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

/** Categories that leave the company by definition: the worker's external flag cannot make them internal. */
export const EXTERNAL_CATEGORIES: readonly ActionCategory[] = ['supplier_inquiry', 'supplier_followup', 'customer_quote', 'new_counterparty', 'drawing_release', 'send_external'];

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

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const list = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);

/** Lower case, accents removed, every separator dropped: 'Beta_Foundry-rev3.pdf' becomes 'betafoundryrev3pdf'. */
function scanForm(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Denylist names found in the text, read through case, accents and separators (spaces, dots, dashes, underscores). */
export function findConfidentialNames(text: string, names: string[]): string[] {
  const hay = scanForm(text);
  return names.filter((n) => typeof n === 'string' && scanForm(n).length > 0 && hay.includes(scanForm(n)));
}

/** An unset denylist, or an empty one without `allowEmptyDenylist`, cannot clear anything: configuration error. */
function denylistErrors(config: PolicyConfig): string[] {
  if (!Array.isArray(config.confidentialNames)) {
    return ['confidential-name denylist is not configured: list the names in confidentialNames, or set an empty list with allowEmptyDenylist: true'];
  }
  const usable = config.confidentialNames.filter((n) => typeof n === 'string' && scanForm(n).length > 0);
  if (!usable.length && config.allowEmptyDenylist !== true) {
    return ['confidential-name denylist is empty: set allowEmptyDenylist: true to accept an empty list'];
  }
  return [];
}

/** Every outgoing field a recipient reads: subject, body, attachment filenames and the display names in the headers. */
function scannedFields(action: ProposedAction): [string, string][] {
  const fields: [string, unknown][] = [['subject', action.subject], ['body', action.text]];
  for (const a of list(action.attachments)) fields.push(['attachment filename', a?.filename]);
  fields.push(['from display name', action.from?.name]);
  for (const [role, recipients] of [['to', action.to], ['cc', action.cc], ['bcc', action.bcc]] as const) {
    for (const r of list(recipients)) fields.push([`${role} display name`, r?.name]);
  }
  return fields.filter((f): f is [string, string] => filled(f[1]));
}

function nameDenials(action: ProposedAction, config: PolicyConfig): string[] {
  const names = list(config.confidentialNames);
  return scannedFields(action).flatMap(([where, value]) => {
    const hits = findConfidentialNames(value, names);
    return hits.length ? [`confidential name in ${where}: ${hits.join(', ')}`] : [];
  });
}

/** An ISO 8601 date-time such as '2026-10-07T07:30:00Z'. Parsing only; no clock is read. */
function isInstant(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * A drawing leaves only with the required number of distinct named checks, by whom and when, on its exact revision.
 * With a verifier only checks on record count.
 */
function drawingDenials(action: ProposedAction, config: PolicyConfig, verifier: PolicyEvidenceVerifier | undefined): string[] {
  const required = config.drawingChecksRequired;
  if (!Number.isInteger(required) || required < 1) {
    return [`drawing-check configuration invalid: drawingChecksRequired must be a whole number of at least 1, got ${JSON.stringify(required ?? null)}`];
  }
  const reasons: string[] = [];
  const drawings = list(action.attachments).filter((a) => a?.kind !== 'document');
  if (action.category === 'drawing_release' && !drawings.length) reasons.push('drawing_release names no drawing in the attachment manifest');
  for (const d of drawings) {
    const done = new Set<string>();
    if (filled(d?.documentId) && filled(d?.revision)) {
      for (const c of list(action.drawingChecks)) {
        if (c?.documentId !== d.documentId || c.revision !== d.revision) continue;
        if (!filled(c.check) || !filled(c.by) || !isInstant(c.at) || !scanForm(c.check)) continue;
        if (verifier && !verifier.drawingCheckRecorded(c)) continue;
        done.add(scanForm(c.check));
      }
    }
    if (done.size < config.drawingChecksRequired) {
      reasons.push(`drawing ${filled(d?.filename) ? d.filename : d?.documentId} revision ${d?.revision} has ${done.size} of ${config.drawingChecksRequired} named checks`);
    }
  }
  return reasons;
}

function attachmentGaps(a: AttachmentEvidence): string[] {
  const missing: string[] = [];
  if (!filled(a?.documentId)) missing.push('documentId');
  if (!filled(a?.revision)) missing.push('revision');
  if (typeof a?.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(a.sha256)) missing.push('sha256 (64 hex characters)');
  if (!filled(a?.filename)) missing.push('filename');
  if (a?.kind !== 'drawing' && a?.kind !== 'document') missing.push('kind (drawing or document)');
  return missing;
}

/** A worker never sends as an identity it is not authorized for, in particular a person's own mailbox. */
function senderDenials(action: ProposedAction, verifier: PolicyEvidenceVerifier | undefined): string[] {
  const from = action.from?.address;
  if (!verifier || !filled(from) || verifier.senderAuthorized(from)) return [];
  return [`sending identity ${from} is not authorized for workers: a worker never sends as a person's own mailbox`];
}

/**
 * The evidence references an L2 allow needs (template revision, From, To) and the verifier's verdict on each of them,
 * on every Cc and Bcc recipient and on every attachment. Without a verifier the claims stay claims: ask.
 */
function verifiedEvidenceGaps(action: ProposedAction, verifier: PolicyEvidenceVerifier | undefined): string[] {
  const gaps: string[] = [];
  const templateRef = filled(action.templateId) && filled(action.templateVersion);
  if (!templateRef) gaps.push('no templateId and templateVersion: templateApproved is a claim, not evidence');
  if (!filled(action.from?.address)) gaps.push('no sending identity (from)');
  if (!list(action.to).some((r) => filled(r?.address))) gaps.push('no recipient (to)');
  if (!verifier) {
    gaps.push('no evidence verifier: templateApproved, counterpartyInRegister and recipientKnown are claims, not evidence');
    return gaps;
  }
  if (templateRef && !verifier.templateApproved(action.templateId!.trim(), action.templateVersion!.trim())) {
    gaps.push(`template ${action.templateId} version ${action.templateVersion} is not an approved revision`);
  }
  for (const r of [...list(action.to), ...list(action.cc), ...list(action.bcc)]) {
    if (!filled(r?.address) || !verifier.recipientInRegister(r.address)) gaps.push(`recipient ${filled(r?.address) ? r.address : '(no address)'} is not in the register`);
  }
  for (const a of list(action.attachments)) {
    if (!attachmentGaps(a).length && !verifier.attachmentMatches(a)) gaps.push(`attachment ${a.filename} does not match the document store (document, revision, sha256)`);
  }
  return gaps;
}

/** What an autonomous external message must carry beyond the worker's claims: disclosure, supervisor, a complete manifest. */
function messageEvidenceGaps(action: ProposedAction): string[] {
  const gaps: string[] = [];
  if (action.disclosureRendered !== true) gaps.push('disclosure line is not rendered in the outgoing message');
  if (!filled(action.supervisor)) gaps.push('no named supervisor for an autonomous message');
  list(action.attachments).forEach((a, i) => {
    const missing = attachmentGaps(a);
    if (missing.length) gaps.push(`attachment manifest entry ${i + 1} is incomplete: ${missing.join(', ')}`);
  });
  return gaps;
}

export function decide(action: ProposedAction, config: PolicyConfig = DEFAULT_POLICY, context: PolicyContext = {}): PolicyResult {
  const reasons: string[] = [];
  const rank = LEVEL_RANK[action.level];

  // A category that leaves the company by definition is external whatever the worker's flag says.
  const external = action.external !== false || EXTERNAL_CATEGORIES.includes(action.category);

  // 1. Internal work: reads always; notes and drafts from L1. An uncertain classification and the categories that always
  //    need a person go to a person, external flag or not.
  if (!external) {
    if (action.uncertain) return { decision: 'ask', reasons: ['classification is uncertain: a person decides'], disclosureRequired: false };
    if (config.alwaysAsk.includes(action.category)) {
      return { decision: 'ask', reasons: [`${action.category} always needs a person, internal or external`], disclosureRequired: false };
    }
    if (action.category === 'read') return { decision: 'allow', reasons: ['read is always allowed'], disclosureRequired: false };
    if (rank >= 1 && (action.category === 'internal_note' || action.category === 'draft')) {
      return { decision: 'allow', reasons: ['internal work at L1 or above'], disclosureRequired: false };
    }
    if (rank === 0) return { decision: 'ask', reasons: ['L0 observes only'], disclosureRequired: false };
    return { decision: 'allow', reasons: ['internal action'], disclosureRequired: false };
  }

  // 2. Hard denials for anything external, collected together; no later approval overrides them.
  const denials = [
    ...denylistErrors(config),
    ...nameDenials(action, config),
    ...clockDenials(action, config, context.now),
    ...drawingDenials(action, config, context.verifier),
    ...senderDenials(action, context.verifier),
  ];
  if (denials.length) return { decision: 'deny', reasons: denials, disclosureRequired: true };

  // 3. Always a person: uncertain classification, prices, quotes, orders, contracts, new counterparties, unknown recipients.
  if (action.uncertain) reasons.push('classification is uncertain: a person decides');
  if (config.alwaysAsk.includes(action.category)) reasons.push(`${action.category} always needs a person`);
  if (action.statesOurPrice) reasons.push('message states our price');
  if (action.counterpartyInRegister === false) reasons.push('counterparty not in the register');
  if (action.recipientKnown === false) reasons.push('recipient unknown');
  if (action.templateApproved === false) reasons.push('template not approved by a person');
  if (reasons.length) return { decision: 'ask', reasons, disclosureRequired: true };

  // 4. Level gates for external action.
  if (rank < 2) return { decision: 'ask', reasons: [`level ${action.level} may not send externally`], disclosureRequired: true };
  if (rank === 2) {
    if (!config.l2Autonomous.includes(action.category)) {
      return { decision: 'ask', reasons: [`${action.category} is outside the L2 autonomous scope`], disclosureRequired: true };
    }
    // Autonomous only on verified evidence: the worker's true claims grant nothing by themselves.
    const gaps = [...messageEvidenceGaps(action), ...verifiedEvidenceGaps(action, context.verifier)];
    if (gaps.length) return { decision: 'ask', reasons: gaps, disclosureRequired: true };
    return {
      decision: 'allow',
      reasons: ['L2: verified template revision, registered recipients, authorized sender, matching attachments; disclosure rendered; named supervisor'],
      disclosureRequired: true,
    };
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

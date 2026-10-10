/**
 * Layer 4 machine channel: bus messages. The XS coordination pattern (private repository xs-lab, docs/LOOP_PROTOCOL.md "Bus",
 * tools/loop_guard.py, reviewed at commit 3609694), ported, not copied: one file per message in
 * <namespace>/coordination/<pair>/, named <UTC>_<ROLE>_<n>.md, created exclusively and never edited or deleted.
 * Header lines, one blank line, then an optional short body. The headers carry the handover of AI_TEAM_ROLES section 3:
 * task id or path, what is done, evidence, what is open, next owner, next date; times are UTC in machine records.
 *
 * Differences from the XS file names, on purpose: the UTC part carries milliseconds and every new message is stamped after
 * every message its writer has seen, so the file order is the causal order even when two turns fall into one second (XS
 * sorted by whole seconds and then by author name). Names with whole seconds are still read.
 * Metadata only: pointers to evidence, never company data, mail content or a send. The body is bounded in size.
 */
import { readdir, readFile } from 'node:fs/promises';

export const MESSAGE_STATUSES = ['DONE', 'NOTE', 'PROBLEM', 'ACTION_REQUIRED', 'STOP'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** A role message carrying this line waits for the owner (XS used a marker naming its owner). */
export const WAITING_MARKER = '[WAITING FOR OWNER]';

export const ROLE_ID = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
export const RUN_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A run key of an attempt: the pattern above, and never 'none', which marks the owner's messages. */
export function isRunKey(value: unknown): value is string {
  return typeof value === 'string' && RUN_KEY.test(value) && value !== 'none';
}
const FILE_NAME = /^(\d{8}T\d{6}(?:\d{3})?Z)_([A-Za-z][A-Za-z0-9-]{0,31})_(\d{3,})\.md$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const DEFAULT_MAX_BODY_BYTES = 4096;

export interface MessageFields {
  author: string;
  status: MessageStatus;
  /** File name of the message this one answers, or 'none'. */
  inReplyTo: string;
  /** Task id or file path. */
  task: string;
  done: string;
  /** Commit, path, message id or test: never empty for a role message. */
  evidence: string;
  open: string;
  /** A role, the owner, or 'none'. */
  nextOwner: string;
  /** YYYY-MM-DD or 'none'. */
  nextDate: string;
  /** Run key of the attempt that wrote the message; 'none' for the owner. */
  runKey: string;
  body: string;
}

export interface BusMessage extends MessageFields {
  file: string;
  timestampUtc: string;
  /** Epoch milliseconds of the file name's UTC part. */
  tsMs: number;
  seq: number;
  /** Why the file is not a valid message (empty when valid). Invalid files still count for the order. */
  problems: string[];
}

const HEADERS: [keyof MessageFields, string][] = [
  ['author', 'AUTHOR'],
  ['status', 'STATUS'],
  ['inReplyTo', 'IN_REPLY_TO'],
  ['task', 'TASK'],
  ['done', 'DONE'],
  ['evidence', 'EVIDENCE'],
  ['open', 'OPEN'],
  ['nextOwner', 'NEXT_OWNER'],
  ['nextDate', 'NEXT_DATE'],
  ['runKey', 'RUN_KEY'],
];

/** 'YYYYMMDDTHHMMSSmmmZ' for an epoch millisecond value. */
export function fileStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, '');
}

function stampMs(stamp: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})?Z$/.exec(stamp);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7] ?? 0));
}

export function parseFileName(name: string): { tsMs: number; author: string; seq: number } | null {
  const m = FILE_NAME.exec(name);
  if (!m) return null;
  const tsMs = stampMs(m[1]);
  return Number.isNaN(tsMs) ? null : { tsMs, author: m[2], seq: Number(m[3]) };
}

export function compareMessages(a: { tsMs: number; author: string; seq: number; file: string }, b: { tsMs: number; author: string; seq: number; file: string }): number {
  return a.tsMs - b.tsMs || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0) || a.seq - b.seq || (a.file < b.file ? -1 : 1);
}

/** The stamp of a new message: the clock, but always after every message the writer has seen. */
export function nextStampMs(nowMs: number, seen: readonly BusMessage[]): number {
  const latest = seen.reduce((max, m) => Math.max(max, m.tsMs), Number.NEGATIVE_INFINITY);
  return Math.max(nowMs, latest + 1);
}

export function nextSeq(author: string, seen: readonly BusMessage[]): number {
  return seen.filter((m) => m.author === author).reduce((max, m) => Math.max(max, m.seq), 0) + 1;
}

export function messageFileName(author: string, stampMs: number, seq: number): string {
  return `${fileStamp(stampMs)}_${author}_${String(seq).padStart(3, '0')}.md`;
}

export function serializeMessage(fields: MessageFields, timestampUtc: string): string {
  const head = HEADERS.map(([key, header]) => `${header}: ${fields[key]}`);
  head.splice(9, 0, `TIMESTAMP_UTC: ${timestampUtc}`);
  const body = fields.body.trim();
  return `${head.join('\n')}\n\n${body ? `${body}\n` : ''}`;
}

/** Parse one message file. The author, stamp and number come from the file name, as in XS. */
export function parseMessage(file: string, text: string): BusMessage | null {
  const name = parseFileName(file);
  if (!name) return null;
  const split = text.indexOf('\n\n');
  const headText = split >= 0 ? text.slice(0, split) : text;
  const body = split >= 0 ? text.slice(split + 2) : '';
  const head = new Map<string, string>();
  for (const line of headText.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) head.set(line.slice(0, i).trim().toUpperCase(), line.slice(i + 1).trim());
  }
  const problems: string[] = [];
  const value = (header: string): string => {
    const v = head.get(header);
    if (v === undefined || v === '') problems.push(`header ${header} missing`);
    return v ?? '';
  };
  const fields = Object.fromEntries(HEADERS.map(([key, header]) => [key, value(header)])) as unknown as Omit<MessageFields, 'body'>;
  const timestampUtc = value('TIMESTAMP_UTC');
  if (fields.author && fields.author !== name.author) problems.push(`header AUTHOR ${fields.author} differs from the file name author ${name.author}`);
  if (fields.status && !MESSAGE_STATUSES.includes(fields.status)) problems.push(`STATUS ${fields.status} is not one of ${MESSAGE_STATUSES.join(', ')}`);
  return { ...fields, author: name.author, body: body.trim(), file, timestampUtc, tsMs: name.tsMs, seq: name.seq, problems };
}

/** All messages of a bus folder, in causal order. Files whose names do not match are not messages (for example .gitkeep). */
export async function listMessages(dir: string): Promise<BusMessage[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: BusMessage[] = [];
  for (const name of names) {
    if (!parseFileName(name)) continue;
    const m = parseMessage(name, await readFile(`${dir}/${name}`, 'utf8'));
    if (m) out.push(m);
  }
  return out.sort(compareMessages);
}

export interface MessageRules {
  roles: readonly string[];
  owner: string;
  /** File names already on the bus (IN_REPLY_TO must name one of them, or 'none'). */
  existing: ReadonlySet<string>;
  maxBodyBytes?: number;
}

/** Why a message may not be written. Every header is one line; role messages carry task, done and evidence. */
export function messageErrors(f: MessageFields, rules: MessageRules): string[] {
  const errors: string[] = [];
  const isOwner = f.author === rules.owner;
  if (!rules.roles.includes(f.author) && !isOwner) errors.push(`author ${f.author} is neither a role (${rules.roles.join(', ')}) nor the owner`);
  if (!MESSAGE_STATUSES.includes(f.status)) errors.push(`status must be one of ${MESSAGE_STATUSES.join(', ')}`);
  if (f.status === 'STOP' && !isOwner) errors.push('only the owner writes a STOP message');
  for (const [key, header] of HEADERS) {
    const v = f[key];
    if (typeof v !== 'string' || !v.trim()) errors.push(`${header} is empty (write none when there is nothing)`);
    else if (/[\r\n]/.test(v)) errors.push(`${header} contains a line break`);
    else if (v.length > 500) errors.push(`${header} is longer than 500 characters: pointers, not content`);
  }
  if (f.inReplyTo !== 'none' && !rules.existing.has(f.inReplyTo)) errors.push(`IN_REPLY_TO ${f.inReplyTo} is not a message on this bus`);
  if (f.nextOwner !== 'none' && !rules.roles.includes(f.nextOwner) && f.nextOwner !== rules.owner) errors.push(`NEXT_OWNER ${f.nextOwner} is not a role or the owner`);
  if (f.nextDate !== 'none' && (!DATE.test(f.nextDate) || Number.isNaN(Date.parse(`${f.nextDate}T00:00:00Z`)))) errors.push('NEXT_DATE must be YYYY-MM-DD or none');
  if (isOwner) {
    if (f.runKey !== 'none') errors.push('the owner writes outside attempts: RUN_KEY none');
  } else {
    if (!isRunKey(f.runKey)) errors.push('RUN_KEY must be the run key of the attempt');
    for (const [key, header] of [['task', 'TASK'], ['done', 'DONE'], ['evidence', 'EVIDENCE']] as const) {
      if (f[key].trim() === 'none') errors.push(`${header} of a role message is never none`);
    }
  }
  const all = [...HEADERS.map(([key]) => f[key]), f.body].join('\n');
  if (/[\u2013\u2014]/.test(all)) errors.push('typographic dash found; use a hyphen');
  const max = rules.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (Buffer.byteLength(f.body, 'utf8') > max) errors.push(`body is longer than ${max} bytes: the bus carries metadata and pointers only`);
  return errors;
}

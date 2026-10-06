/**
 * Layer 4, memory: the append-only handover ledger.
 * Format (canon, stratosteel/stratosteel/02_PROGRAMS/HANDOVER_LEDGER.md):
 *   YYYY-MM-DD HH:MM TZ | from | to | task | status | evidence
 * Rules: append only; status is one of DONE, OPEN, PROBLEM, STOP; evidence is never empty
 * (commit, path, message id, test); no typographic dashes; one line per handover.
 */
import { appendFile, readFile } from 'node:fs/promises';

export type LedgerStatus = 'DONE' | 'OPEN' | 'PROBLEM' | 'STOP';

export interface LedgerEntry {
  /** 'YYYY-MM-DD HH:MM TZ', e.g. '2026-10-06 23:55 CEST'. */
  when: string;
  from: string;
  to: string;
  task: string;
  status: LedgerStatus;
  evidence: string;
}

const WHEN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Z]{3,5}$/;
const STATUSES: LedgerStatus[] = ['DONE', 'OPEN', 'PROBLEM', 'STOP'];

export function validateEntry(e: LedgerEntry): string[] {
  const errors: string[] = [];
  if (!WHEN.test(e.when)) errors.push('when must be "YYYY-MM-DD HH:MM TZ"');
  for (const k of ['from', 'to', 'task', 'evidence'] as const) {
    if (!e[k] || !e[k].trim()) errors.push(`${k} is empty`);
    if (e[k] && e[k].includes('|')) errors.push(`${k} contains the field separator "|"`);
    if (e[k] && /[\n\r]/.test(e[k])) errors.push(`${k} contains a line break`);
  }
  if (!STATUSES.includes(e.status)) errors.push(`status must be one of ${STATUSES.join(', ')}`);
  const all = [e.task, e.evidence, e.from, e.to].join(' ');
  if (/[\u2013\u2014]/.test(all)) errors.push('typographic dash found; use a hyphen');
  return errors;
}

export function formatLine(e: LedgerEntry): string {
  const errors = validateEntry(e);
  if (errors.length) throw new Error(`invalid ledger entry: ${errors.join('; ')}`);
  return `${e.when} | ${e.from} | ${e.to} | ${e.task} | ${e.status} | ${e.evidence}`;
}

export function parseLine(line: string): LedgerEntry | null {
  const parts = line.split(' | ');
  if (parts.length < 6) return null;
  const [when, from, to, task, status, ...rest] = parts;
  if (!STATUSES.includes(status as LedgerStatus)) return null;
  return { when, from, to, task, status: status as LedgerStatus, evidence: rest.join(' | ') };
}

/** Append one line to a ledger file. Never rewrites. Returns the written line. */
export async function appendEntry(path: string, e: LedgerEntry): Promise<string> {
  const line = formatLine(e);
  let prefix = '';
  try {
    const current = await readFile(path, 'utf8');
    if (current.length && !current.endsWith('\n')) prefix = '\n';
  } catch {
    // new file
  }
  await appendFile(path, `${prefix}${line}\n`, 'utf8');
  return line;
}

/** Read the last n parsable entries of a ledger file (oldest first). */
export async function readTail(path: string, n = 20): Promise<LedgerEntry[]> {
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const entries = text.split('\n').map(parseLine).filter((x): x is LedgerEntry => x !== null);
  return entries.slice(-n);
}

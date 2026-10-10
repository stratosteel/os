/**
 * The rendered outgoing message and its content hash: the exact From, To, Cc, Bcc, subject, body and attachment manifest
 * a send intent carries, hashed in one canonical form, so that the send record, the transport and later the approval
 * binding agree on "the same message" byte for byte. A changed recipient, word or attachment reference is a different
 * hash; display-name whitespace and address case are not.
 */
import { createHash } from 'node:crypto';
import type { AttachmentEvidence, MessageAddress } from './policy.js';

export interface RenderedMessage {
  from: MessageAddress;
  to: MessageAddress[];
  cc?: MessageAddress[];
  bcc?: MessageAddress[];
  subject: string;
  body: string;
  /** Manifest of the exact files: document id, immutable revision, sha256 of the bytes, file name, kind. */
  attachments?: AttachmentEvidence[];
}

/** The stored form: every list present, addresses trimmed and lower-cased, names trimmed, manifest fields only. */
export interface NormalizedMessage {
  from: MessageAddress;
  to: MessageAddress[];
  cc: MessageAddress[];
  bcc: MessageAddress[];
  subject: string;
  body: string;
  attachments: AttachmentEvidence[];
}

/** JSON with object keys sorted at every level and undefined members dropped: one byte sequence per value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    if (value === undefined) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function address(a: MessageAddress): MessageAddress {
  if (!a || typeof a.address !== 'string' || !a.address.trim()) throw new Error('every address needs a non-empty address');
  const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : undefined;
  return name ? { address: a.address.trim().toLowerCase(), name } : { address: a.address.trim().toLowerCase() };
}

function attachment(a: AttachmentEvidence): AttachmentEvidence {
  return { documentId: a.documentId, revision: a.revision, sha256: a.sha256.toLowerCase(), filename: a.filename, kind: a.kind };
}

export function normalizeMessage(m: RenderedMessage): NormalizedMessage {
  if (!m || typeof m.subject !== 'string' || typeof m.body !== 'string') throw new Error('a rendered message needs a subject and a body');
  if (!Array.isArray(m.to) || m.to.length === 0) throw new Error('a rendered message needs at least one To recipient');
  return {
    from: address(m.from),
    to: m.to.map(address),
    cc: (m.cc ?? []).map(address),
    bcc: (m.bcc ?? []).map(address),
    subject: m.subject,
    body: m.body,
    attachments: (m.attachments ?? []).map(attachment),
  };
}

/** SHA-256 over the canonical normalized message: the immutable content hash of a send intent. */
export function messageContentHash(m: RenderedMessage): string {
  return sha256Hex(canonicalJson(normalizeMessage(m)));
}

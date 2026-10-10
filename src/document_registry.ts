/**
 * A mock of the system of record's document store: the trusted state an approval is checked against at the dispatch
 * boundary (A11 of the functional specification; G3-A11 of the independent review of 2026-10-07).
 *
 * Documents have immutable revisions; each revision has a file name, a kind and the SHA-256 of its exact bytes, kept as
 * content-addressed blobs; named drawing checks (which check, by whom, when) are recorded per revision. Every change and
 * every dispatch check is one line of an append-only log with a sequence number, written under one lock file: that log
 * is the version fence. A revision update before a dispatch check makes the approval stale (0 transport calls); a
 * dispatch check before the update fixes the bytes that leave, and the later update marks the sent record superseded.
 * `replaceBytes` models what the outside world does to "immutable" files: new bytes under the same file name and the
 * same revision label; the hash shows it.
 *
 * A real records provider (FABRIX or Odoo) must offer the same guarantees: immutable revisions with byte hashes and a
 * transaction or version fence between "a revision changed" and "a dispatch was checked".
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appendDurable, errorCode, errorText, withFileLock } from './file_lock.js';
import { sha256Hex } from './message.js';

export type DocumentKind = 'drawing' | 'document';

export interface RegistryRevision {
  revision: string;
  filename: string;
  kind: DocumentKind;
  sha256: string;
  seq: number;
  at: string;
  by: string;
}

export interface RegistryDocument {
  documentId: string;
  /** The current revision: the last one added. */
  current: string;
  revisions: Map<string, RegistryRevision>;
}

export interface RegistryCheck {
  documentId: string;
  revision: string;
  check: string;
  by: string;
  at: string;
  seq: number;
}

export type RegistryEventBody =
  | { type: 'revision_added'; documentId: string; revision: string; filename: string; kind: DocumentKind; sha256: string; by: string }
  | { type: 'bytes_replaced'; documentId: string; revision: string; sha256: string; by: string }
  | { type: 'check_recorded'; documentId: string; revision: string; check: string; by: string; checkedAt: string }
  | { type: 'check_revoked'; documentId: string; revision: string; check: string; by: string }
  | {
      type: 'dispatch_fence'; intentId: string; worker: string; sendFence: number; attempt: number; bindingHash: string | null;
      documents: { documentId: string; revision: string; sha256: string }[];
      /** The approval as the gate saw it, read under the approval queue's lock. */
      approval?: { approvalId: string; status: string };
    }
  | { type: 'dispatch_refused'; intentId: string; worker: string; sendFence: number; attempt: number; reasons: string[]; approval?: { approvalId: string; status: string } };

export type RegistryEvent = { seq: number; at: string; pid: number } & RegistryEventBody;

export interface RegistryState {
  /** Sequence number of the last log line: the registry version. */
  seq: number;
  documents: Map<string, RegistryDocument>;
  checks: RegistryCheck[];
  log: RegistryEvent[];
}

/** What a fenced section may do while it holds the registry lock. */
export interface FenceOps {
  /** Record that a dispatch was checked against this state and may proceed; returns the line's sequence number. */
  commit(body: Extract<RegistryEventBody, { type: 'dispatch_fence' }>): Promise<number>;
  /** Record that a dispatch was checked against this state and refused; returns the line's sequence number. */
  refuse(body: Extract<RegistryEventBody, { type: 'dispatch_refused' }>): Promise<number>;
  /** The exact bytes of a revision as of this state, verified against its hash. */
  readBytes(documentId: string, revision: string): Promise<Uint8Array>;
}

function reduce(events: RegistryEvent[]): RegistryState {
  const documents = new Map<string, RegistryDocument>();
  let checks: RegistryCheck[] = [];
  for (const ev of events) {
    if (ev.type === 'revision_added') {
      const doc = documents.get(ev.documentId) ?? { documentId: ev.documentId, current: ev.revision, revisions: new Map() };
      doc.revisions.set(ev.revision, { revision: ev.revision, filename: ev.filename, kind: ev.kind, sha256: ev.sha256, seq: ev.seq, at: ev.at, by: ev.by });
      doc.current = ev.revision;
      documents.set(ev.documentId, doc);
    } else if (ev.type === 'bytes_replaced') {
      const rev = documents.get(ev.documentId)?.revisions.get(ev.revision);
      if (rev) Object.assign(rev, { sha256: ev.sha256, seq: ev.seq, at: ev.at, by: ev.by });
    } else if (ev.type === 'check_recorded') {
      checks.push({ documentId: ev.documentId, revision: ev.revision, check: ev.check, by: ev.by, at: ev.checkedAt, seq: ev.seq });
    } else if (ev.type === 'check_revoked') {
      checks = checks.filter((c) => !(c.documentId === ev.documentId && c.revision === ev.revision && c.check === ev.check));
    }
  }
  return { seq: events.length ? events[events.length - 1].seq : 0, documents, checks, log: events };
}

export class DocumentRegistry {
  constructor(readonly dir: string, private readonly options: { clock?: () => Date } = {}) {}

  static async init(dir: string, options: { clock?: () => Date } = {}): Promise<DocumentRegistry> {
    await mkdir(path.join(dir, 'blobs'), { recursive: true });
    return new DocumentRegistry(dir, options);
  }

  private get logPath(): string {
    return path.join(this.dir, 'log.jsonl');
  }

  private get lockPath(): string {
    return path.join(this.dir, 'lock');
  }

  private blobPath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`not a sha256: ${sha256}`);
    return path.join(this.dir, 'blobs', sha256);
  }

  private now(): Date {
    return (this.options.clock ?? (() => new Date()))();
  }

  async log(): Promise<RegistryEvent[]> {
    let text: string;
    try {
      text = await readFile(this.logPath, 'utf8');
    } catch (e) {
      if (errorCode(e) === 'ENOENT') return [];
      throw new Error(`document registry ${this.dir} cannot be read: ${errorText(e)}`, { cause: e });
    }
    const lines = text.split('\n');
    lines.pop();
    return lines.filter((l) => l.trim()).map((l, i) => {
      try {
        return JSON.parse(l) as RegistryEvent;
      } catch (e) {
        throw new Error(`document registry ${this.dir} line ${i + 1} is not a valid event`, { cause: e });
      }
    });
  }

  async state(): Promise<RegistryState> {
    return reduce(await this.log());
  }

  private async writeBlob(bytes: Uint8Array): Promise<string> {
    const sha256 = sha256Hex(bytes);
    try {
      await writeFile(this.blobPath(sha256), bytes, { flag: 'wx' });
    } catch (e) {
      if (errorCode(e) !== 'EEXIST') throw e;
    }
    return sha256;
  }

  /** Append under the lock that the caller holds; `seq` is the next sequence number. */
  private async appendLocked(seq: number, body: RegistryEventBody): Promise<RegistryEvent> {
    const ev = { seq, at: this.now().toISOString(), pid: process.pid, ...body } as RegistryEvent;
    await appendDurable(this.logPath, JSON.stringify(ev) + '\n');
    return ev;
  }

  private async change(validate: (state: RegistryState) => RegistryEventBody): Promise<RegistryEvent> {
    return withFileLock(this.lockPath, async () => {
      const state = await this.state();
      return this.appendLocked(state.seq + 1, validate(state));
    });
  }

  /** Add a new immutable revision; it becomes the current one. A revision label is never reused. */
  async addRevision(documentId: string, input: { revision: string; filename: string; kind: DocumentKind; bytes: Uint8Array }, by: string): Promise<RegistryEvent> {
    const sha256 = await this.writeBlob(input.bytes);
    return this.change((state) => {
      if (state.documents.get(documentId)?.revisions.has(input.revision)) throw new Error(`document ${documentId} already has revision ${input.revision}`);
      return { type: 'revision_added', documentId, revision: input.revision, filename: input.filename, kind: input.kind, sha256, by };
    });
  }

  /** New bytes under the same file name and revision label (an overwrite in place); the revision's hash changes. */
  async replaceBytes(documentId: string, revision: string, bytes: Uint8Array, by: string): Promise<RegistryEvent> {
    const sha256 = await this.writeBlob(bytes);
    return this.change((state) => {
      if (!state.documents.get(documentId)?.revisions.has(revision)) throw new Error(`document ${documentId} has no revision ${revision}`);
      return { type: 'bytes_replaced', documentId, revision, sha256, by };
    });
  }

  async recordCheck(documentId: string, revision: string, check: string, by: string, checkedAt: string): Promise<RegistryEvent> {
    return this.change((state) => {
      if (!state.documents.get(documentId)?.revisions.has(revision)) throw new Error(`document ${documentId} has no revision ${revision}`);
      return { type: 'check_recorded', documentId, revision, check, by, checkedAt };
    });
  }

  async revokeCheck(documentId: string, revision: string, check: string, by: string): Promise<RegistryEvent> {
    return this.change(() => ({ type: 'check_revoked', documentId, revision, check, by }));
  }

  /** The exact bytes of a revision, verified against the hash the state holds. */
  async readBytes(documentId: string, revision: string, state?: RegistryState): Promise<Uint8Array> {
    const s = state ?? (await this.state());
    const rev = s.documents.get(documentId)?.revisions.get(revision);
    if (!rev) throw new Error(`document ${documentId} has no revision ${revision}`);
    const bytes = new Uint8Array(await readFile(this.blobPath(rev.sha256)));
    if (sha256Hex(bytes) !== rev.sha256) throw new Error(`document ${documentId} revision ${revision}: stored bytes do not match ${rev.sha256}`);
    return bytes;
  }

  /**
   * The version fence: run `work` under the registry lock with the current state. Changes wait until it ends, so the
   * state it checked is the state at the sequence number its commit or refusal line records.
   */
  async fence<T>(work: (state: RegistryState, ops: FenceOps) => Promise<T>): Promise<T> {
    return withFileLock(this.lockPath, async () => {
      const state = await this.state();
      let seq = state.seq;
      const ops: FenceOps = {
        commit: async (body) => (await this.appendLocked(++seq, body)).seq,
        refuse: async (body) => (await this.appendLocked(++seq, body)).seq,
        readBytes: (documentId, revision) => this.readBytes(documentId, revision, state),
      };
      return work(state, ops);
    });
  }
}

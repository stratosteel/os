/**
 * Layer 1 write path: the only way anything leaves the company. MailProvider stays read-only; sending exists only behind
 * SendTransport, and only the send record dispatcher (send_dispatcher.ts) calls submit(), after the send record has
 * durably recorded the attempt.
 *
 * Acceptance is not delivery. Microsoft Graph `user: sendMail` answers 202 Accepted with no response body
 * (https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0). That confirms the service accepted
 * the request; it does not confirm that the message was processed, saved to Sent Items or delivered, and it returns no
 * message id. A transport therefore reports acceptance at most. "Observed in Sent" comes only from findSent(), the
 * provider's own Sent evidence, and this template has no delivered state because it has no delivery evidence.
 *
 * FakeTransport is the reference double: file-backed so that several OS processes share one provider, with a scripted
 * failure matrix (proven rejection before acceptance, acceptance with a lost response, timeout without acceptance,
 * delayed appearance in Sent, slow responses) and a ledger of every call and every Sent query for the tests' evidence.
 * It never touches a network.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AttachmentEvidence, MessageAddress } from './policy.js';
import { errorCode, errorText, pause, withFileLock } from './file_lock.js';
import { messageContentHash, sha256Hex } from './message.js';

/** One file as it leaves: the manifest reference and, when the dispatcher resolved them, the exact bytes. */
export interface OutgoingAttachment extends AttachmentEvidence {
  bytes?: Uint8Array;
}

export interface OutgoingMessage {
  /** Correlation id of the send intent, carried in the message so that the provider's Sent evidence can be matched. */
  correlationId: string;
  from: MessageAddress;
  to: MessageAddress[];
  cc: MessageAddress[];
  bcc: MessageAddress[];
  subject: string;
  body: string;
  attachments: OutgoingAttachment[];
}

export interface SubmitContext {
  /** The intent's idempotency key, the same on every attempt; it deduplicates only where the provider proves it does. */
  idempotencyKey: string;
  attempt: number;
  worker: string;
}

/** The provider accepted the request. Acceptance only: not processing, not Sent, not delivery. */
export interface SubmitAck {
  /** Status of the acceptance; Graph sendMail answers 202. */
  status: number;
  /** Provider message id when the endpoint returns one; Graph sendMail returns none. */
  transportMessageId?: string;
  /** The provider recognised the idempotency key and accepted nothing new. */
  deduplicated?: boolean;
  at: string;
}

/**
 * 'not_accepted' only with proof that the provider accepted nothing (a definitive rejection before acceptance, or a
 * connection that never reached it). Everything else, timeouts and lost responses included, is 'unknown'.
 */
export type Acceptance = 'not_accepted' | 'unknown';

export class TransportError extends Error {
  constructor(message: string, readonly acceptance: Acceptance, readonly status?: number) {
    super(message);
    this.name = 'TransportError';
  }
}

/** How a failed submit() is read: anything that is not a TransportError proving non-acceptance is ambiguous. */
export function classifyFailure(e: unknown): { acceptance: Acceptance; error: string; status?: number } {
  if (e instanceof TransportError) return { acceptance: e.acceptance, error: e.message, status: e.status };
  return { acceptance: 'unknown', error: errorText(e) };
}

/** The provider's own evidence that a message with this correlation id is in the Sent folder. */
export interface SentEvidence {
  /** Provider id of the item in Sent. */
  messageId: string;
  correlationId: string;
  /** Hash of the content as the provider holds it, when it can be computed. */
  contentHash?: string;
  /** When the item appeared in Sent according to the provider. */
  sentAt?: string;
  source: string;
}

/**
 * Provider-side deduplication. 'none' is the honest default (Graph sendMail has no idempotency key). A transport may
 * declare an idempotency key only together with the recorded proof for the chosen endpoint; only then may the dispatcher
 * retry an ambiguous attempt.
 */
export type Deduplication = { kind: 'none' } | { kind: 'idempotency-key'; proven: true; evidence: string };

export interface SendTransport {
  readonly name: string;
  readonly deduplication: Deduplication;
  /** Submit once. Resolves on acceptance; throws (preferably a TransportError) otherwise. */
  submit(message: OutgoingMessage, context: SubmitContext): Promise<SubmitAck>;
  /** Read-only: the provider's Sent evidence for a correlation id. An empty answer is not proof of non-acceptance. */
  findSent(correlationId: string): Promise<SentEvidence[]>;
}

// ---------------------------------------------------------------------------------------------------------------------
// FakeTransport

export type FakeStepKind = 'accept' | 'reject_before_acceptance' | 'accept_then_lose_response' | 'timeout_without_acceptance';

export interface FakeStep {
  kind: FakeStepKind;
  /** An accepted message appears in Sent this long after acceptance (delayed appearance in Sent). */
  sentDelayMs?: number;
  /** An accepted message appears in Sent only after this many Sent queries for its correlation id (deterministic delay). */
  sentVisibleAfterQueries?: number;
  /** The provider answers this long after the call started; acceptance itself happens at the start. */
  responseDelayMs?: number;
}

export interface FakeScript {
  /** Steps for the calls of one correlation id, in call order; the last step repeats. */
  byCorrelation?: Record<string, FakeStep[]>;
  /** Steps for every other correlation id, in call order; the last step repeats. Default: accept. */
  default?: FakeStep[];
}

export type FakeCallOutcome = 'accepted' | 'deduplicated' | 'rejected' | 'accepted_response_lost' | 'timed_out';

/** One call to submit(), as the fake provider saw it. */
export interface FakeCall {
  seq: number;
  callId: string;
  at: string;
  pid: number;
  worker: string;
  attempt: number;
  idempotencyKey: string;
  correlationId: string;
  /** Content hash of the message as received, computed by the provider side. */
  contentHash: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  attachments: { documentId: string; revision: string; sha256: string; filename: string; bytesSha256?: string; bytesLength?: number }[];
  step: FakeStep;
  outcome: FakeCallOutcome;
  messageId?: string;
}

/** A message the fake provider accepted; it shows in Sent from visibleAt (and after the configured number of queries). */
export interface FakeSentItem {
  messageId: string;
  correlationId: string;
  idempotencyKey: string;
  contentHash: string;
  callSeq: number;
  acceptedAt: string;
  visibleAt: string;
  visibleAfterQueries: number;
}

export interface FakeQuery {
  at: string;
  pid: number;
  correlationId: string;
  found: string[];
}

export interface FakeTransportOptions {
  /** Clock of the fake provider (acceptance times and Sent visibility). */
  clock?: () => Date;
  /** Model a provider that deduplicates by idempotency key, recording this text as the proof. Off by default. */
  idempotencyKeyProof?: string;
  name?: string;
}

async function readJsonDir<T>(dir: string): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if (errorCode(e) === 'ENOENT') return [];
    throw e;
  }
  const items: T[] = [];
  for (const n of names.filter((x) => x.endsWith('.json')).sort()) {
    items.push(JSON.parse(await readFile(path.join(dir, n), 'utf8')) as T);
  }
  return items;
}

export class FakeTransport implements SendTransport {
  readonly name: string;
  readonly deduplication: Deduplication;
  private readonly clock: () => Date;

  constructor(readonly dir: string, options: FakeTransportOptions = {}) {
    this.name = options.name ?? 'fake-transport';
    this.clock = options.clock ?? (() => new Date());
    this.deduplication = options.idempotencyKeyProof
      ? { kind: 'idempotency-key', proven: true, evidence: options.idempotencyKeyProof }
      : { kind: 'none' };
  }

  /** Create the provider's directory with a script of outcomes and return a transport over it. */
  static async create(dir: string, script: FakeScript = {}, options: FakeTransportOptions = {}): Promise<FakeTransport> {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'script.json'), JSON.stringify(script, null, 2) + '\n', 'utf8');
    return new FakeTransport(dir, options);
  }

  private async script(): Promise<FakeScript> {
    try {
      return JSON.parse(await readFile(path.join(this.dir, 'script.json'), 'utf8')) as FakeScript;
    } catch (e) {
      if (errorCode(e) === 'ENOENT') return {};
      throw e;
    }
  }

  async calls(): Promise<FakeCall[]> {
    return (await readJsonDir<FakeCall>(path.join(this.dir, 'calls'))).sort((a, b) => a.seq - b.seq);
  }

  async sentItems(): Promise<FakeSentItem[]> {
    return readJsonDir<FakeSentItem>(path.join(this.dir, 'sent'));
  }

  async queries(): Promise<FakeQuery[]> {
    return (await readJsonDir<FakeQuery>(path.join(this.dir, 'queries'))).sort((a, b) => a.at.localeCompare(b.at));
  }

  async submit(message: OutgoingMessage, context: SubmitContext): Promise<SubmitAck> {
    const contentHash = messageContentHash(message);
    const attachments = (message.attachments ?? []).map((a) => ({
      documentId: a.documentId,
      revision: a.revision,
      sha256: a.sha256,
      filename: a.filename,
      ...(a.bytes ? { bytesSha256: sha256Hex(a.bytes), bytesLength: a.bytes.length } : {}),
    }));
    const script = await this.script();
    await mkdir(path.join(this.dir, 'calls'), { recursive: true });
    await mkdir(path.join(this.dir, 'sent'), { recursive: true });
    // Choose the scripted step and record the call under the provider's lock, so that calls from several processes get
    // consistent sequence numbers and per-correlation step indexes.
    const call = await withFileLock(path.join(this.dir, 'lock'), async () => {
      const previous = await this.calls();
      const steps = script.byCorrelation?.[message.correlationId] ?? script.default ?? [{ kind: 'accept' as const }];
      const index = previous.filter((c) => c.correlationId === message.correlationId).length;
      const step = steps[Math.min(index, steps.length - 1)] ?? { kind: 'accept' as const };
      const now = this.clock();
      const seq = previous.length + 1;
      let outcome: FakeCallOutcome;
      let messageId: string | undefined;
      let sent: FakeSentItem | undefined;
      const prior = this.deduplication.kind === 'idempotency-key'
        ? (await this.sentItems()).find((s) => s.idempotencyKey === context.idempotencyKey)
        : undefined;
      if (prior && step.kind !== 'reject_before_acceptance') {
        outcome = 'deduplicated';
        messageId = prior.messageId;
      } else if (step.kind === 'accept' || step.kind === 'accept_then_lose_response') {
        outcome = step.kind === 'accept' ? 'accepted' : 'accepted_response_lost';
        messageId = `fake-msg-${randomUUID()}`;
        sent = {
          messageId,
          correlationId: message.correlationId,
          idempotencyKey: context.idempotencyKey,
          contentHash,
          callSeq: seq,
          acceptedAt: now.toISOString(),
          visibleAt: new Date(now.getTime() + (step.sentDelayMs ?? 0)).toISOString(),
          visibleAfterQueries: step.sentVisibleAfterQueries ?? 0,
        };
      } else {
        outcome = step.kind === 'reject_before_acceptance' ? 'rejected' : 'timed_out';
      }
      const record: FakeCall = {
        seq,
        callId: randomUUID(),
        at: now.toISOString(),
        pid: process.pid,
        worker: context.worker,
        attempt: context.attempt,
        idempotencyKey: context.idempotencyKey,
        correlationId: message.correlationId,
        contentHash,
        from: message.from.address,
        to: message.to.map((a) => a.address),
        cc: (message.cc ?? []).map((a) => a.address),
        bcc: (message.bcc ?? []).map((a) => a.address),
        subject: message.subject,
        attachments,
        step,
        outcome,
        ...(messageId ? { messageId } : {}),
      };
      await writeFile(path.join(this.dir, 'calls', `${String(seq).padStart(6, '0')}-${record.callId}.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
      if (sent) await writeFile(path.join(this.dir, 'sent', `${sent.messageId}.json`), JSON.stringify(sent, null, 2) + '\n', { flag: 'wx' });
      return record;
    });
    if (call.step.responseDelayMs) await pause(call.step.responseDelayMs);
    switch (call.outcome) {
      case 'accepted':
        // Graph sendMail: 202 Accepted with an empty body, so no message id comes back.
        return { status: 202, at: call.at };
      case 'deduplicated':
        return { status: 202, at: call.at, deduplicated: true };
      case 'accepted_response_lost':
        throw new TransportError('no response: the connection was lost after the request was sent (the provider accepted it)', 'unknown');
      case 'timed_out':
        throw new TransportError('no response: the request timed out (the provider accepted nothing)', 'unknown');
      case 'rejected':
        throw new TransportError('rejected before acceptance: 400 Bad Request', 'not_accepted', 400);
    }
  }

  async findSent(correlationId: string): Promise<SentEvidence[]> {
    await mkdir(path.join(this.dir, 'queries'), { recursive: true });
    const visible = await withFileLock(path.join(this.dir, 'lock'), async () => {
      const now = this.clock();
      const before = (await this.queries()).filter((q) => q.correlationId === correlationId).length;
      const items = (await this.sentItems()).filter(
        (s) => s.correlationId === correlationId && Date.parse(s.visibleAt) <= now.getTime() && before >= s.visibleAfterQueries,
      );
      const query: FakeQuery = { at: now.toISOString(), pid: process.pid, correlationId, found: items.map((s) => s.messageId) };
      const name = `${String(before + 1).padStart(6, '0')}-${query.at.replace(/[:.]/g, '-')}-${randomUUID()}.json`;
      await writeFile(path.join(this.dir, 'queries', name), JSON.stringify(query, null, 2) + '\n', { flag: 'wx' });
      return items;
    });
    return visible.map((s) => ({ messageId: s.messageId, correlationId, contentHash: s.contentHash, sentAt: s.visibleAt, source: `${this.name}:sent` }));
  }
}

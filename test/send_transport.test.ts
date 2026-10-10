/**
 * Pins the send transport boundary for G3 (A09 of the independent review of 2026-10-07: "Current MailProvider exposes
 * reads only; there is no implemented send/outbox/reconciliation interface") and the modelled semantics of the fake
 * provider every A05 and A09 test relies on.
 *
 * SendTransport is the only write path; MailProvider stays read-only; no tool sends; the mock bundle carries the fake.
 * FakeTransport behaves as modelled: an acceptance answers 202 with no message id (as Graph sendMail does); a proven
 * rejection before acceptance is the only 'not_accepted' failure; an acceptance with a lost response and a timeout
 * without acceptance look identical to the caller ('unknown'); Sent visibility can be delayed by time or by queries; a
 * slow answer comes after the acceptance; an idempotency key deduplicates only when the proof is configured. Every call
 * and every Sent query is recorded in files that several processes share.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MockMail, mockProviders } from '../src/mock.js';
import { createServer } from '../src/server.js';
import { messageContentHash } from '../src/message.js';
import { FakeTransport, TransportError, classifyFailure, type OutgoingMessage, type SubmitContext } from '../src/transport.js';

const MESSAGE: OutgoingMessage = {
  correlationId: 'corr-0001',
  from: { address: 'rfq-worker@example.com', name: 'RFQ desk' },
  to: [{ address: 'offers@example.com' }],
  cc: [],
  bcc: [{ address: 'archive@example.com' }],
  subject: 'ACME-RFQ-0001 steel supply',
  body: 'Please quote the attached scope.',
  attachments: [{ documentId: 'doc-0002', revision: '1', sha256: '4c7e'.repeat(16), filename: 'rfq_scope_rev1.pdf', kind: 'document' }],
};
const CTX: SubmitContext = { idempotencyKey: 'idem-0001', attempt: 1, worker: 'worker-a' };

async function fake(script: Parameters<typeof FakeTransport.create>[1] = {}, options: Parameters<typeof FakeTransport.create>[2] = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'os-transport-'));
  return FakeTransport.create(dir, script, options);
}

async function failure(p: Promise<unknown>): Promise<TransportError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof TransportError, `expected a TransportError, got ${String(e)}`);
    return e;
  }
  assert.fail('expected the submission to fail');
}

test('transport boundary: MailProvider stays read-only, no tool sends, only the dispatcher may call submit(), the mock bundle carries the fake', async () => {
  assert.deepEqual(Object.getOwnPropertyNames(MockMail.prototype).sort(), ['constructor', 'getMessage', 'searchMail']);
  const dir = await mkdtemp(path.join(tmpdir(), 'os-boundary-'));
  const providers = mockProviders(path.join(dir, 'ledger.md'));
  assert.ok(providers.transport instanceof FakeTransport);
  assert.equal(providers.transport.deduplication.kind, 'none', 'no deduplication is assumed (Graph sendMail has none)');
  const { tools } = await createServer({ stateDir: dir });
  assert.deepEqual(tools.filter((x) => /send|submit|dispatch|transport/i.test(x.name)).map((x) => x.name), [], 'no tool sends');
  for (const file of (await readdir(path.resolve('src'))).filter((f) => f.endsWith('.ts'))) {
    const code = (await readFile(path.resolve('src', file), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const callers = code.match(/\.submit\(/g) ?? [];
    assert.equal(callers.length, file === 'send_dispatcher.ts' ? 1 : 0, `${file} calls submit() ${callers.length} times`);
  }
});

test('FakeTransport: an acceptance answers 202 with no message id; the call and the Sent item are recorded with the content hash', async () => {
  const t = await fake();
  const ack = await t.submit(MESSAGE, CTX);
  assert.deepEqual([ack.status, ack.transportMessageId, ack.deduplicated], [202, undefined, undefined], 'Graph sendMail: 202 Accepted, empty body');
  const [call] = await t.calls();
  assert.deepEqual([call.seq, call.worker, call.attempt, call.correlationId, call.idempotencyKey, call.outcome], [1, 'worker-a', 1, 'corr-0001', 'idem-0001', 'accepted']);
  assert.equal(call.contentHash, messageContentHash(MESSAGE));
  assert.deepEqual([call.from, call.to, call.bcc], ['rfq-worker@example.com', ['offers@example.com'], ['archive@example.com']]);
  const found = await t.findSent('corr-0001');
  assert.equal(found.length, 1);
  assert.equal(found[0].messageId, call.messageId, 'the provider id is known from the Sent evidence, not from the acceptance');
  assert.equal(found[0].contentHash, call.contentHash);
  assert.deepEqual(await t.findSent('corr-other'), []);
  assert.equal((await t.queries()).length, 2);
});

test('FakeTransport: only a proven rejection before acceptance is not_accepted; a lost response and a timeout look the same to the caller', async () => {
  const rejected = await fake({ default: [{ kind: 'reject_before_acceptance' }] });
  const r = await failure(rejected.submit(MESSAGE, CTX));
  assert.deepEqual([r.acceptance, r.status], ['not_accepted', 400]);
  assert.deepEqual(await rejected.sentItems(), []);

  const lost = await fake({ default: [{ kind: 'accept_then_lose_response' }] });
  const l = await failure(lost.submit(MESSAGE, CTX));
  assert.equal(l.acceptance, 'unknown');
  assert.equal((await lost.sentItems()).length, 1, 'the provider did accept it');

  const timedOut = await fake({ default: [{ kind: 'timeout_without_acceptance' }] });
  const o = await failure(timedOut.submit(MESSAGE, CTX));
  assert.equal(o.acceptance, 'unknown');
  assert.deepEqual(await timedOut.sentItems(), [], 'the provider accepted nothing');
  assert.deepEqual([l.name, l.acceptance], [o.name, o.acceptance], 'the caller cannot tell the two apart: both are ambiguous');

  assert.deepEqual(classifyFailure(new Error('socket hang up')), { acceptance: 'unknown', error: 'socket hang up' }, 'anything that is not a proven rejection is ambiguous');
  assert.deepEqual((await rejected.calls()).map((c) => c.outcome), ['rejected']);
});

test('FakeTransport: delayed appearance in Sent, by time or by number of queries; a slow answer comes after the acceptance', async () => {
  let now = new Date('2026-10-10T08:00:00.000Z');
  const byTime = await fake({ default: [{ kind: 'accept', sentDelayMs: 60_000 }] }, { clock: () => now });
  await byTime.submit(MESSAGE, CTX);
  assert.deepEqual(await byTime.findSent('corr-0001'), []);
  now = new Date('2026-10-10T08:00:59.999Z');
  assert.deepEqual(await byTime.findSent('corr-0001'), []);
  now = new Date('2026-10-10T08:01:00.000Z');
  assert.equal((await byTime.findSent('corr-0001')).length, 1);

  const byQueries = await fake({ default: [{ kind: 'accept', sentVisibleAfterQueries: 2 }] });
  await byQueries.submit(MESSAGE, CTX);
  const seen = [];
  for (let i = 0; i < 4; i += 1) seen.push((await byQueries.findSent('corr-0001')).length);
  assert.deepEqual(seen, [0, 0, 1, 1]);

  const slow = await fake({ default: [{ kind: 'accept', responseDelayMs: 150 }] });
  const started = Date.now();
  const pending = slow.submit(MESSAGE, CTX);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await slow.findSent('corr-0001')).length, 1, 'accepted before the answer arrives');
  await pending;
  assert.ok(Date.now() - started >= 140);
});

test('FakeTransport: an idempotency key deduplicates only with a recorded proof; without one a second submission is a second message', async () => {
  const proof = 'modelled by FakeTransport for tests; no real endpoint is claimed';
  const deduplicating = await fake({}, { idempotencyKeyProof: proof });
  assert.deepEqual(deduplicating.deduplication, { kind: 'idempotency-key', proven: true, evidence: proof });
  await deduplicating.submit(MESSAGE, CTX);
  const second = await deduplicating.submit(MESSAGE, { ...CTX, attempt: 2 });
  assert.deepEqual([second.status, second.deduplicated], [202, true]);
  assert.equal((await deduplicating.sentItems()).length, 1);
  assert.deepEqual((await deduplicating.calls()).map((c) => c.outcome), ['accepted', 'deduplicated']);

  const plain = await fake();
  await plain.submit(MESSAGE, CTX);
  await plain.submit(MESSAGE, { ...CTX, attempt: 2 });
  assert.equal((await plain.sentItems()).length, 2, 'this is why the dispatcher never resends on ambiguity');
});

test('FakeTransport: scripted steps follow the call order per correlation id, and two instances on one directory share the provider', async () => {
  const a = await fake({ byCorrelation: { 'corr-0001': [{ kind: 'reject_before_acceptance' }, { kind: 'accept' }] } });
  const b = new FakeTransport(a.dir);
  await failure(a.submit(MESSAGE, CTX));
  await b.submit(MESSAGE, { ...CTX, attempt: 2, worker: 'worker-b' });
  await b.submit({ ...MESSAGE, correlationId: 'corr-0002' }, { ...CTX, idempotencyKey: 'idem-0002', worker: 'worker-b' });
  const calls = await a.calls();
  assert.deepEqual(calls.map((c) => [c.seq, c.worker, c.correlationId, c.outcome]), [
    [1, 'worker-a', 'corr-0001', 'rejected'],
    [2, 'worker-b', 'corr-0001', 'accepted'],
    [3, 'worker-b', 'corr-0002', 'accepted'],
  ]);
  assert.equal((await b.findSent('corr-0001')).length, 1);
});

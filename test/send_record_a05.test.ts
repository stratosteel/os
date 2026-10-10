/**
 * Pins G3-A05 of the independent review of 2026-10-07 (ASTRA): two workers, one intended send.
 *
 * One business send intent per (tenant, inquiry or package, supplier, inquiry revision, action or follow-up step). A
 * changed worker id, task id or a regenerated draft finds the same intent; a deliberately distinct follow-up step or an
 * authorized new revision is a new intent and is sent (positive control). Claims are atomic and fenced; a stale worker
 * cannot dispatch after a takeover; the attempt history is one durable append-only log.
 *
 * The integration cases start 2 independent OS processes (node dist/test/fixtures/send_worker.js) on one store directory
 * and one counting fake transport: forced to race at a barrier file with the same event delivered twice to each, and with
 * a lease that expires while its worker is stopped with SIGSTOP. Every case persists its input fixture, the intent, the
 * event and attempt trace, the transport calls with their count, the Sent queries and the process trace, and prints the
 * paths (set OS_EVIDENCE_DIR to keep them in one place).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SendRecordStore, intentIdOf, type SendIntentInput, type SendIntentKey } from '../src/send_record.js';
import { SendDispatcher } from '../src/send_dispatcher.js';
import { FakeTransport } from '../src/transport.js';
import { KEY, Trace, initStore, intentInput, persistEvidence, startWorker, workspace, writeEventFixture } from './send_fixtures.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const waitUntil = async (epochMs: number) => sleep(Math.max(0, epochMs - Date.now()));

function eventFor(id: string, packageId: string, patch: Partial<SendIntentInput> = {}) {
  return { id, type: 'supplier_inquiry.send', intent: intentInput({ key: { ...KEY, packageId }, ...patch }) };
}

test('A05: the intent key is tenant, package, supplier, inquiry revision and step; worker, task and draft text are not part of it', async (t) => {
  const base = intentIdOf(KEY);
  assert.equal(intentIdOf({ ...KEY }), base);
  assert.equal(intentIdOf({ ...KEY, workerId: 'worker-b', taskId: 'task-9' } as unknown as SendIntentKey), base, 'other fields are dropped');
  assert.equal(intentIdOf({ ...KEY, tenant: '  tenant-template ' }), base, 'key fields are trimmed');
  for (const field of ['tenant', 'packageId', 'supplierId', 'inquiryRevision', 'step'] as const) {
    assert.notEqual(intentIdOf({ ...KEY, [field]: `${KEY[field]}-x` }), base, field);
  }
  assert.throws(() => intentIdOf({ ...KEY, step: ' ' }), /non-empty step/);

  const ws = await workspace('a05-key');
  const store = await initStore(ws);
  const first = await store.create(intentInput());
  const otherWorker = await store.create(intentInput({ createdBy: { worker: 'worker-b', task: 'task-b-7' } }));
  const regenerated = await store.create(intentInput({
    createdBy: { worker: 'worker-c', task: 'task-c-2' },
    message: { ...intentInput().message, body: `${intentInput().message.body}\n\nRegenerated draft.` },
  }));
  assert.deepEqual([first.created, otherWorker.created, regenerated.created], [true, false, false]);
  assert.deepEqual([otherWorker.sameContent, regenerated.sameContent], [true, false]);
  assert.equal(otherWorker.record.intentId, first.record.intentId);
  assert.equal(regenerated.record.intentId, first.record.intentId);
  const record = await store.read(first.record.intentId);
  assert.equal(record.intent.contentHash, first.record.intent.contentHash, 'the stored content stays the first rendering');
  assert.deepEqual(record.suppressed.map((s) => [s.worker, s.task, s.sameContent]), [['worker-b', 'task-b-7', true], ['worker-c', 'task-c-2', false]]);
  assert.equal((await store.list()).length, 1, 'one intent in the store');
  await persistEvidence(t, ws, { intentIds: [first.record.intentId] });
});

test('A05: the reducer voids a stale or racing event even when the lock is bypassed, and the writer sees its own event void', async (t) => {
  const ws = await workspace('a05-reducer');
  const store = await initStore(ws);
  const id = (await store.create(intentInput())).record.intentId;
  const claim = (worker: string, fence: number, ms: number) =>
    store.transact(id, worker, (_r, now) => ({ type: 'claimed', fence, leaseUntil: new Date(now.getTime() + ms).toISOString() }));
  const submit = (worker: string, fence: number, attempt: number) =>
    store.transact(id, worker, (r) => ({ type: 'submit_started', fence, attempt, contentHash: r.intent.contentHash, idempotencyKey: r.intent.idempotencyKey }));

  assert.equal((await claim('worker-a', 1, 40)).accepted, true);
  await sleep(80);
  assert.equal((await claim('worker-b', 2, 10_000)).accepted, true, 'the takeover after the lease expired is valid');
  // worker-a, unaware of the takeover, writes its submission as if its own checks had been defeated:
  const stale = await submit('worker-a', 1, 1);
  assert.equal(stale.appended, true);
  assert.equal(stale.accepted, false, 'the writer re-reads and finds its event void, so it never calls the transport');
  assert.match(stale.reason ?? '', /stale fence 1: the current fence is 2/);
  const racing = await claim('worker-c', 3, 10_000);
  assert.equal(racing.accepted, false);
  assert.match(racing.reason ?? '', /lease held by worker-b \(fence 2\)/);
  assert.equal((await submit('worker-b', 2, 1)).accepted, true);
  const second = await submit('worker-b', 2, 2);
  assert.equal(second.accepted, false);
  assert.match(second.reason ?? '', /attempt 1 is unresolved: reconcile before any retry/);

  const rebuilt = await new SendRecordStore(ws.storeDir).read(id);
  assert.deepEqual(rebuilt.voided.map((v) => v.type), ['submit_started', 'claimed', 'submit_started'], 'a fresh reader reaches the same verdicts from the log');
  assert.deepEqual(rebuilt.attempts.map((a) => [a.attempt, a.worker, a.fence]), [[1, 'worker-b', 2]]);
  await persistEvidence(t, ws, { intentIds: [id] });
});

test('A05 positive control: a distinct follow-up step and an authorized new revision are new intents and are sent, not suppressed', async (t) => {
  const ws = await workspace('a05-positive');
  const store = await initStore(ws);
  const transport = await FakeTransport.create(ws.transportDir);
  const dispatcher = new SendDispatcher({ store, transport, worker: 'worker-a', leaseMs: 5_000, reconcileBackoffMs: 10 });
  const send = async (input: SendIntentInput) => dispatcher.dispatch((await store.create(input)).record.intentId);
  const message = intentInput().message;

  const initial = await send(intentInput());
  const followup = await send(intentInput({ key: { ...KEY, step: 'followup-1' }, message: { ...message, subject: `Reminder: ${message.subject}` } }));
  const revision2 = await send(intentInput({ key: { ...KEY, inquiryRevision: '2' }, message: { ...message, subject: `${message.subject}, revision 2` } }));
  const redelivered = await send(intentInput({ createdBy: { worker: 'worker-b', task: 'task-b-1' } }));

  assert.deepEqual([initial, followup, revision2].map((o) => [o.kind, o.submitted]), [['observed_sent', 1], ['observed_sent', 1], ['observed_sent', 1]]);
  assert.deepEqual([redelivered.kind, redelivered.submitted], ['already_sent', 0], 'the same initial event again is suppressed');
  const calls = await transport.calls();
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map((c) => c.correlationId)).size, 3, 'three intents, three correlation ids');
  assert.equal((await store.list()).length, 3);
  await persistEvidence(t, ws, { intentIds: [initial, followup, revision2].map((o) => o.record.intentId) });
});

// The fake provider answers slowly so that the winner is still in flight when the loser arrives; the last round widens
// the window to 1 s and asserts that the loser met the held lease (contention, not a sequential replay).
const RACES = [150, 150, 150, 150, 1_000].map((responseDelayMs, i) => ({ round: i + 1, responseDelayMs, assertContention: responseDelayMs >= 1_000 }));

for (const { round, responseDelayMs, assertContention } of RACES) {
  test(`A05 race ${round}/${RACES.length}: two worker processes released at a barrier, the event delivered twice to each: exactly one submission`, async (t) => {
    const ws = await workspace(`a05-race-${round}`);
    await initStore(ws);
    await FakeTransport.create(ws.transportDir, { default: [{ kind: 'accept', responseDelayMs }] });
    const trace = new Trace();
    const event = eventFor(`evt-a05-race-${round}`, `ACME-PKG-01${String(round).padStart(2, '0')}`);
    const { path: fixturePath, fixture } = await writeEventFixture(ws, event);
    const barrierPath = path.join(ws.root, 'barrier');
    const a = await startWorker(ws, trace, { fixturePath, worker: 'worker-a', task: 'task-a-1', deliveries: 2, leaseMs: 15_000, barrierPath });
    const b = await startWorker(ws, trace, { fixturePath, worker: 'worker-b', task: 'task-b-7', deliveries: 2, leaseMs: 15_000, barrierPath, regenerateDraft: true });
    await Promise.all([a.line('ready'), b.line('ready')]);
    await writeFile(barrierPath, 'go\n');
    trace.note('barrier opened');
    const [ra, rb] = await Promise.all([a.result(), b.result()]);
    await Promise.all([a.exit, b.exit]);
    const id = intentIdOf(event.intent.key);
    await persistEvidence(t, ws, { fixture, intentIds: [id], trace, summary: { workers: [ra, rb] } });

    const transport = new FakeTransport(ws.transportDir);
    const calls = await transport.calls();
    assert.equal(calls.length, 1, 'exactly one transport submission for the intended send');
    assert.equal((await transport.sentItems()).length, 1);
    const deliveries = [...ra.deliveries, ...rb.deliveries];
    assert.equal(deliveries.length, 4);
    assert.equal(deliveries.reduce((n, d) => n + d.submitted, 0), 1);
    const winner = ra.deliveries.some((d) => d.submitted > 0) ? ra : rb;
    const loser = winner === ra ? rb : ra;
    assert.equal(calls[0].worker, winner.worker);
    for (const d of loser.deliveries) {
      assert.equal(d.submitted, 0, `the loser ${loser.worker} cannot dispatch`);
      assert.ok(['lease_held', 'already_sent'].includes(d.outcome), d.outcome);
    }
    const contended = loser.deliveries.some((d) => d.outcome === 'lease_held');
    t.diagnostic(`round ${round}: winner ${winner.worker}; loser ${loser.worker} outcomes ${loser.deliveries.map((d) => d.outcome).join(', ')}; contention ${contended ? 'observed' : 'not observed'}`);
    if (assertContention) assert.ok(contended, 'with a 1 s in-flight window the loser meets the held lease');
    assert.deepEqual(ra.record, rb.record, 'both workers observe the same send record');
    assert.equal(ra.record.state, 'observed_sent');
    assert.equal(ra.record.transportMessageId, calls[0].messageId);
    assert.equal(calls[0].contentHash, ra.record.contentHash, 'the stored message was submitted, whoever rendered a draft');
    assert.equal(new Set(deliveries.map((d) => d.intentId)).size, 1);
    assert.equal(deliveries.filter((d) => d.created).length, 1);

    const record = await new SendRecordStore(ws.storeDir).read(id);
    assert.equal((await new SendRecordStore(ws.storeDir).list()).length, 1);
    assert.equal(record.suppressed.length, 3, 'three of four deliveries found the existing intent');
    assert.ok(record.suppressed.some((s) => !s.sameContent), 'the regenerated draft was suppressed, not sent');
    assert.equal(record.events.filter((e) => e.type === 'submit_started').length, 1);
    assert.deepEqual(record.voided, [], 'under the lock no void event was even written');
  });
}

test('A05: a lease that expires while its worker is stopped with SIGSTOP is taken over; the stale worker cannot send after recovery', async (t) => {
  const ws = await workspace('a05-sigstop');
  await initStore(ws);
  await FakeTransport.create(ws.transportDir);
  const trace = new Trace();
  const event = eventFor('evt-a05-sigstop', 'ACME-PKG-0201');
  const { path: fixturePath, fixture } = await writeEventFixture(ws, event);
  const id = intentIdOf(event.intent.key);
  const store = new SendRecordStore(ws.storeDir);

  const a = await startWorker(ws, trace, { fixturePath, worker: 'worker-a', task: 'task-a-1', deliveries: 1, leaseMs: 800, pauseAt: 'after_claim' });
  await a.line('paused:after_claim');
  a.stop();
  const held = await store.read(id);
  assert.deepEqual([held.lease?.holder, held.fence], ['worker-a', 1]);
  await waitUntil(Date.parse(held.lease!.until) + 100);
  trace.note(`lease of worker-a (fence 1) expired at ${held.lease!.until}`);

  const b = await startWorker(ws, trace, { fixturePath, worker: 'worker-b', task: 'task-b-7', deliveries: 1, leaseMs: 15_000 });
  const rb = await b.result();
  await b.exit;
  a.resume();
  a.child.stdin.write('continue\n');
  trace.note('worker-a released from its pause point');
  const ra = await a.result();
  await a.exit;
  await persistEvidence(t, ws, { fixture, intentIds: [id], trace, summary: { workers: [ra, rb] } });

  const calls = await new FakeTransport(ws.transportDir).calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].worker, 'worker-b');
  assert.deepEqual(rb.deliveries.map((d) => [d.outcome, d.submitted]), [['observed_sent', 1]]);
  assert.deepEqual(ra.deliveries.map((d) => [d.outcome, d.submitted]), [['fenced', 0]], 'the stale worker cannot send after recovery');
  assert.deepEqual(ra.record, rb.record, 'both observe the same send record');
  const record = await store.read(id);
  assert.deepEqual(record.events.filter((e) => e.type === 'claimed').map((e) => [e.worker, e.type === 'claimed' ? e.fence : 0]), [['worker-a', 1], ['worker-b', 2]]);
  assert.deepEqual(record.events.filter((e) => e.type === 'submit_started').map((e) => e.worker), ['worker-b']);
  assert.deepEqual(record.staleRejections.map((s) => [s.worker, s.fence]), [['worker-a', 1]]);
});

test('A05: a worker stopped after recording its submission but before its final fence check abandons it on resume; the takeover reconciles and never submits', async (t) => {
  const ws = await workspace('a05-abandon');
  await initStore(ws);
  await FakeTransport.create(ws.transportDir);
  const trace = new Trace();
  const event = eventFor('evt-a05-abandon', 'ACME-PKG-0202', { limits: { maxAttempts: 3, maxReconcileQueries: 2 } });
  const { path: fixturePath, fixture } = await writeEventFixture(ws, event);
  const id = intentIdOf(event.intent.key);
  const store = new SendRecordStore(ws.storeDir);

  const a = await startWorker(ws, trace, { fixturePath, worker: 'worker-a', task: 'task-a-1', deliveries: 1, leaseMs: 800, pauseAt: 'after_submit_started' });
  await a.line('paused:after_submit_started');
  a.stop();
  const held = await store.read(id);
  assert.deepEqual(held.attempts.map((x) => [x.attempt, x.worker, x.result]), [[1, 'worker-a', undefined]]);
  await waitUntil(Date.parse(held.lease!.until) + 100);
  trace.note('lease of worker-a expired with attempt 1 started and no result');

  const b = await startWorker(ws, trace, { fixturePath, worker: 'worker-b', task: 'task-b-7', deliveries: 1, leaseMs: 15_000, reconcileBackoffMs: 30 });
  const rb = await b.result();
  await b.exit;
  assert.deepEqual(rb.deliveries.map((d) => [d.outcome, d.submitted]), [['blocked', 0]], 'the takeover reconciles within its bound, escalates and does not submit');
  a.resume();
  a.child.stdin.write('continue\n');
  const ra = await a.result();
  await a.exit;
  assert.deepEqual(ra.deliveries.map((d) => [d.outcome, d.submitted]), [['fenced', 0]], 'the final fence check stops the stale worker');
  assert.equal((await new FakeTransport(ws.transportDir).calls()).length, 0);
  const abandoned = await store.read(id);
  assert.equal(abandoned.attempts[0].result?.outcome, 'not_submitted');
  assert.equal(abandoned.blocked, undefined, 'the ambiguity is resolved by the stale worker itself: nothing was submitted');

  const c = await startWorker(ws, trace, { fixturePath, worker: 'worker-c', task: 'task-c-1', deliveries: 1, leaseMs: 15_000 });
  const rc = await c.result();
  await c.exit;
  await persistEvidence(t, ws, { fixture, intentIds: [id], trace, summary: { workers: [ra, rb, rc] } });
  assert.deepEqual(rc.deliveries.map((d) => [d.outcome, d.submitted]), [['observed_sent', 1]]);
  const calls = await new FakeTransport(ws.transportDir).calls();
  assert.deepEqual(calls.map((x) => [x.worker, x.attempt]), [['worker-c', 2]]);
});

test('A05 residual window (documented deviation): a worker stopped after its final fence check submits once on resume; the takeover never submits; one submission in total', async (t) => {
  const ws = await workspace('a05-residual');
  await initStore(ws);
  await FakeTransport.create(ws.transportDir);
  const trace = new Trace();
  const event = eventFor('evt-a05-residual', 'ACME-PKG-0203', { limits: { maxAttempts: 3, maxReconcileQueries: 2 } });
  const { path: fixturePath, fixture } = await writeEventFixture(ws, event);
  const id = intentIdOf(event.intent.key);
  const store = new SendRecordStore(ws.storeDir);

  const a = await startWorker(ws, trace, { fixturePath, worker: 'worker-a', task: 'task-a-1', deliveries: 1, leaseMs: 800, pauseAt: 'after_final_check' });
  await a.line('paused:after_final_check');
  a.stop();
  const held = await store.read(id);
  await waitUntil(Date.parse(held.lease!.until) + 100);
  trace.note('lease of worker-a expired after its final fence check, before its transport call');
  const b = await startWorker(ws, trace, { fixturePath, worker: 'worker-b', task: 'task-b-7', deliveries: 1, leaseMs: 15_000, reconcileBackoffMs: 30 });
  const rb = await b.result();
  await b.exit;
  assert.deepEqual(rb.deliveries.map((d) => [d.outcome, d.submitted]), [['blocked', 0]]);
  a.resume();
  a.child.stdin.write('continue\n');
  const ra = await a.result();
  await a.exit;
  const reconciled = await new SendDispatcher({ store, transport: new FakeTransport(ws.transportDir), worker: 'reconciler', leaseMs: 5_000 }).reconcileOnce(id);
  await persistEvidence(t, ws, { fixture, intentIds: [id], trace, summary: { workers: [ra, rb] } });

  const calls = await new FakeTransport(ws.transportDir).calls();
  assert.equal(calls.length, 1, 'still exactly one submission: the takeover never submitted');
  assert.equal(calls[0].worker, 'worker-a', 'the stopped worker submitted on resume: the window a provider-side fence would close');
  assert.deepEqual(ra.deliveries.map((d) => [d.outcome, d.submitted, d.late]), [['accepted', 1, true]]);
  assert.equal(reconciled.attempts[0].result?.late, true, 'the late acceptance is recorded as a fact about attempt 1');
  assert.equal(reconciled.escalations.length, 1, 'the ambiguity had been escalated to a person meanwhile');
  assert.equal(reconciled.state, 'observed_sent');
});

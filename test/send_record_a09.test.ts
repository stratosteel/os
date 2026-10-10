/**
 * Pins G3-A09 of the independent review of 2026-10-07 (ASTRA): timeout, restart and reconciliation before any retry.
 *
 * The fake transport's failure matrix: failure proven before acceptance; acceptance followed by a lost response; delayed
 * appearance in Sent; restart after provider acceptance but before the local result is recorded (a child process killed
 * with SIGKILL between the transport's answer and the record write); duplicate resume; unavailable storage; a stale worker
 * returning late. An ambiguous outcome enters unknown_reconciling, the provider's Sent evidence is queried a bounded
 * number of times, a timeout or an empty search never triggers a new submission, unresolved ambiguity is escalated as an
 * approval request (not a resend), and a retry happens only on evidence of non-acceptance or on a provider deduplication
 * proven for the endpoint. The record keeps separate states with a timestamp each and never says sent or delivered
 * without evidence; it is rebuilt identically after a restart. Every case persists its evidence and prints the paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ApprovalQueue } from '../src/approvals.js';
import { SendDispatcher, escalateTo, policyRecheck, type DispatcherOptions } from '../src/send_dispatcher.js';
import {
  SEND_STATES, SendRecordStore, describeSendState, intentIdOf, sendRecordSnapshot,
  type SendIntentInput, type SendLimits,
} from '../src/send_record.js';
import { FakeTransport, type FakeScript } from '../src/transport.js';
import { CONFIG, VERIFIER, bratislava } from './policy_fixtures.js';
import { KEY, Trace, initStore, intentInput, persistEvidence, startWorker, workspace, writeEventFixture, type Workspace } from './send_fixtures.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const waitUntil = async (epochMs: number) => sleep(Math.max(0, epochMs - Date.now()));

interface Setup {
  ws: Workspace;
  store: SendRecordStore;
  transport: FakeTransport;
  queue: ApprovalQueue;
  id: string;
  dispatcher(worker: string, options?: Partial<DispatcherOptions>): SendDispatcher;
}

async function setup(caseName: string, script: FakeScript = {}, opts: { limits?: Partial<SendLimits>; idempotencyKeyProof?: string; input?: Partial<SendIntentInput> } = {}): Promise<Setup> {
  const ws = await workspace(caseName);
  const store = await initStore(ws);
  const transport = await FakeTransport.create(ws.transportDir, script, opts.idempotencyKeyProof ? { idempotencyKeyProof: opts.idempotencyKeyProof } : {});
  const queue = new ApprovalQueue(path.join(ws.root, 'approvals.jsonl'));
  const created = await store.create(intentInput({ ...(opts.input ?? {}), ...(opts.limits ? { limits: opts.limits } : {}) }));
  const id = created.record.intentId;
  const dispatcher = (worker: string, options: Partial<DispatcherOptions> = {}) =>
    new SendDispatcher({ store, transport, worker, leaseMs: 5_000, retryBackoffMs: 5, reconcileBackoffMs: 5, escalate: escalateTo(queue, worker), ...options });
  return { ws, store, transport, queue, id, dispatcher };
}

const outcomes = (calls: { outcome: string }[]) => calls.map((c) => c.outcome);

test('A09: a failure proven before acceptance is retried as a new attempt; exhausted attempts stop and escalate', async (t) => {
  const s = await setup('a09-proven-failure', { default: [{ kind: 'reject_before_acceptance' }, { kind: 'accept' }] });
  const out = await s.dispatcher('worker-a').dispatch(s.id);
  await persistEvidence(t, s.ws, { intentIds: [s.id] });
  assert.deepEqual([out.kind, out.submitted], ['observed_sent', 2]);
  assert.deepEqual(outcomes(await s.transport.calls()), ['rejected', 'accepted']);
  assert.deepEqual(out.record.attempts.map((a) => a.result?.outcome), ['not_accepted', 'accepted']);
  assert.equal((await s.transport.sentItems()).length, 1);

  const x = await setup('a09-proven-failure-exhausted', { default: [{ kind: 'reject_before_acceptance' }] }, { limits: { maxAttempts: 2 } });
  const first = await x.dispatcher('worker-a').dispatch(x.id);
  const again = await x.dispatcher('worker-b').dispatch(x.id);
  await persistEvidence(t, x.ws, { intentIds: [x.id] });
  assert.deepEqual([first.kind, first.submitted], ['failed', 2]);
  assert.match(first.record.blocked ?? '', /attempts exhausted \(2\)/);
  assert.deepEqual([again.kind, again.submitted], ['blocked', 0]);
  assert.equal((await x.transport.calls()).length, 2, 'no third submission');
  const pending = await x.queue.list('pending');
  assert.equal(pending.length, 1, 'the escalation is one approval request for a person');
  assert.equal(pending[0].payload.intentId, x.id);
  assert.equal(first.record.escalations[0].approvalId, pending[0].id);
});

test('A09: an acceptance followed by a lost response is reconciled from the Sent evidence and never resubmitted', async (t) => {
  const s = await setup('a09-lost-response', { default: [{ kind: 'accept_then_lose_response' }] });
  const out = await s.dispatcher('worker-a').dispatch(s.id);
  await persistEvidence(t, s.ws, { intentIds: [s.id] });
  assert.deepEqual([out.kind, out.submitted], ['observed_sent', 1]);
  assert.deepEqual(outcomes(await s.transport.calls()), ['accepted_response_lost']);
  assert.equal(out.record.attempts[0].result?.outcome, 'unknown');
  assert.ok(out.record.transitions.some((x) => x.state === 'unknown_reconciling'), 'the ambiguous outcome entered unknown_reconciling first');
  assert.equal(out.record.transportMessageId, (await s.transport.sentItems())[0].messageId);
});

test('A09: delayed appearance in Sent: reconciliation waits inside its bound, escalates beyond it, and never resubmits', async (t) => {
  const s = await setup('a09-delayed-within', { default: [{ kind: 'accept_then_lose_response', sentVisibleAfterQueries: 2 }] }, { limits: { maxReconcileQueries: 4 } });
  const out = await s.dispatcher('worker-a').dispatch(s.id);
  await persistEvidence(t, s.ws, { intentIds: [s.id] });
  assert.deepEqual([out.kind, out.submitted, out.record.reconcileQueries], ['observed_sent', 1, 3]);
  assert.equal((await s.transport.calls()).length, 1);

  const timed = await setup('a09-delayed-by-time', { default: [{ kind: 'accept_then_lose_response', sentDelayMs: 300 }] }, { limits: { maxReconcileQueries: 20 } });
  const byTime = await timed.dispatcher('worker-a', { reconcileBackoffMs: 50 }).dispatch(timed.id);
  await persistEvidence(t, timed.ws, { intentIds: [timed.id] });
  assert.deepEqual([byTime.kind, byTime.submitted], ['observed_sent', 1]);
  assert.ok(byTime.record.reconcileQueries > 1 && byTime.record.reconcileQueries <= 20, `${byTime.record.reconcileQueries} queries`);

  const beyond = await setup('a09-delayed-beyond', { default: [{ kind: 'accept_then_lose_response', sentVisibleAfterQueries: 3 }] }, { limits: { maxReconcileQueries: 3 } });
  const blocked = await beyond.dispatcher('worker-a').dispatch(beyond.id);
  assert.deepEqual([blocked.kind, blocked.submitted, blocked.record.reconcileQueries], ['blocked', 1, 3]);
  assert.equal((await beyond.dispatcher('worker-b').dispatch(beyond.id)).submitted, 0, 'a blocked intent is not dispatched again');
  assert.equal((await beyond.transport.queries()).length, 3, 'the bound holds across workers');
  const late = await beyond.dispatcher('reconciler').reconcileOnce(beyond.id);
  await persistEvidence(t, beyond.ws, { intentIds: [beyond.id] });
  assert.equal(late.state, 'observed_sent', 'an explicit later check finds the message; nothing was resent');
  assert.equal((await beyond.transport.calls()).length, 1);
});

test('A09: a timeout without acceptance stays unknown: bounded queries, an approval request, no second submission', async (t) => {
  const s = await setup('a09-timeout', { default: [{ kind: 'timeout_without_acceptance' }] }, { limits: { maxReconcileQueries: 3 } });
  const out = await s.dispatcher('worker-a').dispatch(s.id);
  const again = await s.dispatcher('worker-b').dispatch(s.id);
  await persistEvidence(t, s.ws, { intentIds: [s.id] });
  assert.deepEqual([out.kind, out.submitted], ['blocked', 1]);
  assert.equal(out.record.state, 'unknown_reconciling');
  assert.match(out.record.blocked ?? '', /ambiguous outcome escalated/);
  assert.deepEqual([again.kind, again.submitted], ['blocked', 0]);
  assert.equal((await s.transport.calls()).length, 1, 'an empty search is not evidence of non-acceptance: no resend');
  assert.equal((await s.transport.queries()).length, 3);
  const pending = await s.queue.list('pending');
  assert.equal(pending.length, 1);
  assert.match(pending[0].reasons.join(' '), /nothing is resent/);
});

test('A09: restart after the provider accepted but before the result was recorded (SIGKILL at the injected point): reconciliation, no second submission', async (t) => {
  const ws = await workspace('a09-crash-after-ack');
  await initStore(ws);
  await FakeTransport.create(ws.transportDir, { default: [{ kind: 'accept' }] });
  const trace = new Trace();
  const event = { id: 'evt-a09-crash', type: 'supplier_inquiry.send', intent: intentInput({ key: { ...KEY, packageId: 'ACME-PKG-0901' } }) };
  const { path: fixturePath, fixture } = await writeEventFixture(ws, event);
  const id = intentIdOf(event.intent.key);
  const store = new SendRecordStore(ws.storeDir);
  const transport = new FakeTransport(ws.transportDir);

  const crashing = await startWorker(ws, trace, { fixturePath, worker: 'worker-a', task: 'task-a-1', deliveries: 1, leaseMs: 600, crashAt: 'after_ack' });
  await crashing.line('crash:after_ack');
  const exit = await crashing.exit;
  assert.equal(exit.signal, 'SIGKILL');
  const before = await store.read(id);
  assert.deepEqual(before.attempts.map((a) => [a.attempt, a.result]), [[1, undefined]], 'the acceptance never reached the record');
  assert.deepEqual(outcomes(await transport.calls()), ['accepted']);
  await waitUntil(Date.parse(before.lease!.until) + 100);
  trace.note('lease of the killed worker expired');

  const restarted = await startWorker(ws, trace, { fixturePath, worker: 'worker-a', task: 'task-a-1-restart', deliveries: 1, leaseMs: 15_000 });
  const result = await restarted.result();
  await restarted.exit;
  await persistEvidence(t, ws, { fixture, intentIds: [id], trace, summary: { restarted: result } });

  assert.deepEqual(result.deliveries.map((d) => [d.outcome, d.submitted]), [['observed_sent', 0]]);
  const calls = await transport.calls();
  assert.equal(calls.length, 1, 'no second submission after the restart');
  const after = await store.read(id);
  assert.equal(after.state, 'observed_sent');
  assert.ok(after.transitions.some((x) => x.state === 'unknown_reconciling'), 'the restarted worker reconciled before anything else');
  const queries = await transport.queries();
  assert.ok(queries.length >= 1);
  assert.ok(queries.every((q) => q.correlationId === calls[0].correlationId && q.correlationId === after.intent.correlationId), 'the durable correlation id is reused across the restart');
  assert.deepEqual(sendRecordSnapshot(after), result.record, 'the events rebuild the same record in another process');
});

test('A09: duplicate resume: concurrent and repeated dispatches of one intent submit once, also after an interrupted attempt', async (t) => {
  const s = await setup('a09-duplicate-resume', { default: [{ kind: 'accept', responseDelayMs: 100 }] });
  const concurrent = await Promise.all([s.dispatcher('worker-a').dispatch(s.id), s.dispatcher('worker-a').dispatch(s.id), s.dispatcher('worker-b').dispatch(s.id)]);
  const repeated = await s.dispatcher('worker-a').dispatch(s.id);
  await persistEvidence(t, s.ws, { intentIds: [s.id] });
  assert.equal(concurrent.reduce((n, o) => n + o.submitted, 0), 1);
  assert.deepEqual(concurrent.map((o) => o.kind).sort(), ['lease_held', 'lease_held', 'observed_sent']);
  assert.deepEqual([repeated.kind, repeated.submitted], ['already_sent', 0]);
  assert.equal((await s.transport.calls()).length, 1);

  const x = await setup('a09-duplicate-resume-after-interrupt', { default: [{ kind: 'accept' }] });
  const crash = x.dispatcher('worker-a', { leaseMs: 200, onPoint: (point) => { if (point === 'after_ack') throw new Error('injected crash after the transport answered'); } });
  await assert.rejects(crash.dispatch(x.id), /injected crash/);
  await waitUntil(Date.parse((await x.store.read(x.id)).lease!.until) + 50);
  const resumed = await Promise.all([x.dispatcher('worker-a-restarted').dispatch(x.id), x.dispatcher('worker-b').dispatch(x.id)]);
  await persistEvidence(t, x.ws, { intentIds: [x.id] });
  assert.equal(resumed.reduce((n, o) => n + o.submitted, 0), 0, 'resuming an interrupted attempt reconciles, it does not resubmit');
  assert.ok(resumed.some((o) => o.kind === 'observed_sent'));
  assert.equal((await x.transport.calls()).length, 1);
});

test('A09: unavailable storage fails closed: no submission without a durable record, no resend after an unrecorded acceptance', async (t) => {
  // A missing store directory is an unmounted or lost volume, never an empty store.
  const missing = await workspace('a09-storage-missing');
  const transport = await FakeTransport.create(missing.transportDir);
  const absent = new SendRecordStore(missing.storeDir);
  await assert.rejects(absent.create(intentInput()), /send record store .+ is unavailable/);
  await assert.rejects(new SendDispatcher({ store: absent, transport, worker: 'worker-a' }).dispatch(intentIdOf(KEY)), /unavailable/);
  assert.equal((await transport.calls()).length, 0);

  // An event log that cannot be read (a directory where the file must be) fails for every user, root included.
  const unreadable = await setup('a09-storage-unreadable');
  await mkdir(unreadable.store.eventsPath(unreadable.id));
  await assert.rejects(unreadable.dispatcher('worker-a').dispatch(unreadable.id), /cannot be read/);
  assert.equal((await unreadable.transport.calls()).length, 0);

  // The store disappears right before the submission must be recorded: the record write fails, nothing is submitted.
  const vanishing = await setup('a09-storage-vanishing');
  const dir = vanishing.store.dirOf(vanishing.id);
  const gone = vanishing.dispatcher('worker-a', { beforeSubmit: async () => { await rename(dir, `${dir}.unavailable`); return { ok: true }; } });
  await assert.rejects(gone.dispatch(vanishing.id), /cannot be created|ENOENT/);
  assert.equal((await vanishing.transport.calls()).length, 0, 'no submission without a durable submit_started');

  // Read-only mode bits: exercised where they bind (CI runs unprivileged; root ignores them).
  const readOnly = await setup('a09-storage-read-only');
  if (process.getuid?.() === 0) {
    t.diagnostic('read-only mode bits not exercised: this run is root, which ignores them; the cases above cover unwritable storage for root');
  } else {
    const intentDir = readOnly.store.dirOf(readOnly.id);
    await chmod(intentDir, 0o555);
    try {
      await assert.rejects(readOnly.dispatcher('worker-a').dispatch(readOnly.id), /EACCES|cannot be created/);
    } finally {
      await chmod(intentDir, 0o755);
    }
    assert.equal((await readOnly.transport.calls()).length, 0);
  }

  // The provider accepts, then the store disappears before the result is recorded; after recovery: reconcile, no resend.
  const lost = await setup('a09-storage-lost-after-ack', { default: [{ kind: 'accept' }] });
  const lostDir = lost.store.dirOf(lost.id);
  const failing = lost.dispatcher('worker-a', { leaseMs: 300, onPoint: async (point) => { if (point === 'after_ack') await rename(lostDir, `${lostDir}.unavailable`); } });
  await assert.rejects(failing.dispatch(lost.id), /cannot be created|ENOENT/);
  assert.equal((await lost.transport.calls()).length, 1);
  await rename(`${lostDir}.unavailable`, lostDir);
  const recovered = await lost.store.read(lost.id);
  assert.equal(recovered.attempts[0].result, undefined);
  await waitUntil(Date.parse(recovered.lease!.until) + 50);
  const resumed = await lost.dispatcher('worker-a-restarted').dispatch(lost.id);
  await persistEvidence(t, lost.ws, { intentIds: [lost.id] });
  assert.deepEqual([resumed.kind, resumed.submitted], ['observed_sent', 0]);
  assert.equal((await lost.transport.calls()).length, 1);
});

test('A09: a stale worker returning late: its late acceptance is recorded as a fact about its attempt; nothing is resubmitted', async (t) => {
  // Acceptance at the start of a slow call: the takeover finds the message in Sent before the stale worker's answer.
  const s = await setup('a09-stale-late', { default: [{ kind: 'accept', responseDelayMs: 600 }] });
  const slow = s.dispatcher('worker-a', { leaseMs: 200 }).dispatch(s.id);
  await sleep(350);
  const takeover = await s.dispatcher('worker-b', { leaseMs: 5_000 }).dispatch(s.id);
  const stale = await slow;
  await persistEvidence(t, s.ws, { intentIds: [s.id] });
  assert.deepEqual([takeover.kind, takeover.submitted], ['observed_sent', 0]);
  assert.deepEqual([stale.kind, stale.submitted, stale.late], ['accepted', 1, true]);
  const record = await s.store.read(s.id);
  assert.equal(record.state, 'observed_sent', 'the late answer does not move the record backwards');
  assert.deepEqual([record.attempts[0].result?.outcome, record.attempts[0].result?.late], ['accepted', true]);
  assert.equal((await s.transport.calls()).length, 1);

  // Nothing visible in Sent while the stale call is still out: the takeover escalates; the late acceptance then resolves it.
  const x = await setup('a09-stale-late-unseen', { default: [{ kind: 'accept', responseDelayMs: 600, sentVisibleAfterQueries: 99 }] }, { limits: { maxReconcileQueries: 2 } });
  const slow2 = x.dispatcher('worker-a', { leaseMs: 200 }).dispatch(x.id);
  await sleep(350);
  const blocked = await x.dispatcher('worker-b', { leaseMs: 5_000 }).dispatch(x.id);
  const stale2 = await slow2;
  await persistEvidence(t, x.ws, { intentIds: [x.id] });
  assert.deepEqual([blocked.kind, blocked.submitted], ['blocked', 0]);
  assert.deepEqual([stale2.kind, stale2.late], ['accepted', true]);
  const resolved = await x.store.read(x.id);
  assert.deepEqual([resolved.state, resolved.blocked], ['accepted', undefined]);
  assert.equal((await x.transport.calls()).length, 1);
});

test('A09: separate states with a timestamp each; the record never says sent or delivered without evidence', async (t) => {
  assert.deepEqual([...SEND_STATES], ['approved', 'queued', 'accepted', 'observed_sent', 'failed', 'unknown_reconciling']);
  const s = await setup('a09-labels', { default: [{ kind: 'accept', sentVisibleAfterQueries: 1 }] }, {
    input: { authorization: { kind: 'approval', approvalId: 'approval-0001' } },
  });
  // This case checks the record's fields and labels. An approval-authorized send needs the approval-binding gate since
  // A11; an accept-all test gate stands in here, the binding itself is pinned in test/approval_binding_a11.test.ts.
  const accepted = await s.dispatcher('worker-a', { gate: { check: async () => ({ ok: true }) } }).dispatch(s.id);
  assert.equal(accepted.kind, 'accepted');
  const r1 = accepted.record;
  assert.equal(r1.state, 'accepted', 'a 202 acceptance with nothing in Sent yet is accepted, not sent');
  assert.match(describeSendState(r1), /accepted by the provider .*not processing or delivery.*not yet observed in the Sent folder/);
  const r2 = await s.dispatcher('reconciler').reconcileOnce(s.id);
  assert.equal(r2.state, 'observed_sent');
  assert.match(describeSendState(r2), /observed in the provider's Sent folder as fake-msg-.*delivery to the recipients is not known/);
  for (const state of SEND_STATES) {
    const label = describeSendState({ ...r2, state });
    assert.doesNotMatch(label, /\bdelivered\b|\bwas sent\b|\bhas been sent\b|\bsent to\b/i, `${state}: ${label}`);
  }
  for (const state of ['approved', 'queued', 'accepted', 'observed_sent'] as const) assert.ok(r2.stateTimes[state], `${state} has a timestamp`);
  const times = ['approved', 'queued', 'accepted', 'observed_sent'].map((x) => Date.parse(r2.stateTimes[x as 'approved']!));
  assert.deepEqual([...times].sort((a, b) => a - b), times, 'the timestamps follow the order of the states');

  const snap = sendRecordSnapshot(r2);
  const call = (await s.transport.calls())[0];
  assert.deepEqual([snap.from.address, snap.to.map((a) => a.address), snap.cc, snap.bcc.map((a) => a.address)], [call.from, call.to, call.cc, call.bcc]);
  assert.equal(snap.contentHash, call.contentHash);
  assert.deepEqual(snap.attachments, [{ documentId: 'doc-0002', revision: '1', sha256: '4c7e'.repeat(16) }]);
  assert.deepEqual([snap.templateId, snap.templateVersion, snap.approvalId], ['tpl-rfq-supplier', '3', 'approval-0001']);
  assert.match(snap.policyVersion, /^policy-sha256:[0-9a-f]{64}$/);
  assert.equal(snap.correlationId, call.correlationId);
  assert.equal(snap.transportMessageId, (await s.transport.sentItems())[0].messageId, 'the message id comes from the Sent evidence: Graph sendMail returns none');
  assert.equal(r1.attempts[0].result?.status, 202);
  assert.equal(r1.transportMessageId, undefined, 'no message id is invented from a 202');
  await persistEvidence(t, s.ws, { intentIds: [s.id] });
});

test('A09: the events are reconstructable: a new store instance rebuilds the same record, transitions and attempts', async (t) => {
  const s = await setup('a09-reconstruct', { default: [{ kind: 'reject_before_acceptance' }, { kind: 'accept_then_lose_response', sentVisibleAfterQueries: 1 }] });
  const out = await s.dispatcher('worker-a').dispatch(s.id);
  await persistEvidence(t, s.ws, { intentIds: [s.id] });
  assert.equal(out.kind, 'observed_sent');
  const fresh = await new SendRecordStore(s.ws.storeDir).read(s.id);
  assert.deepEqual(sendRecordSnapshot(fresh), sendRecordSnapshot(out.record));
  assert.deepEqual(fresh.transitions.map((x) => x.state), ['approved', 'queued', 'failed', 'queued', 'unknown_reconciling', 'observed_sent']);
  assert.deepEqual(fresh.attempts.map((a) => a.result?.outcome), ['not_accepted', 'unknown']);
  const lines = (await readFile(s.store.eventsPath(s.id), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { type: string });
  assert.deepEqual(fresh.events.map((e) => e.type), lines.map((l) => l.type));
});

test('A09: retry after an ambiguous outcome only with a provider deduplication proven for the endpoint', async (t) => {
  const proof = 'modelled by FakeTransport: the fake provider deduplicates by idempotency key; no real endpoint is claimed';
  const script: FakeScript = { default: [{ kind: 'accept_then_lose_response', sentVisibleAfterQueries: 99 }] };
  const s = await setup('a09-dedup-proven', script, { idempotencyKeyProof: proof, limits: { maxReconcileQueries: 2 } });
  const out = await s.dispatcher('worker-a').dispatch(s.id);
  await persistEvidence(t, s.ws, { intentIds: [s.id] });
  assert.deepEqual([out.kind, out.submitted], ['accepted', 2]);
  assert.deepEqual(outcomes(await s.transport.calls()), ['accepted_response_lost', 'deduplicated']);
  assert.equal((await s.transport.sentItems()).length, 1, 'the provider accepted one message');
  assert.equal(out.record.attempts[1].dedupProof, proof);
  assert.equal(out.record.attempts[1].result?.deduplicated, true);

  const n = await setup('a09-dedup-none', script, { limits: { maxReconcileQueries: 2 } });
  assert.equal(n.transport.deduplication.kind, 'none', 'the default, as for Graph sendMail');
  const plain = await n.dispatcher('worker-a').dispatch(n.id);
  await persistEvidence(t, n.ws, { intentIds: [n.id] });
  assert.deepEqual([plain.kind, plain.submitted], ['blocked', 1]);
  assert.equal((await n.transport.calls()).length, 1);
});

test('A09: the stored message is immutable: an altered intent is refused before any submission', async (t) => {
  const s = await setup('a09-immutable');
  const file = s.store.intentPath(s.id);
  const intent = JSON.parse(await readFile(file, 'utf8')) as { message: { to: { address: string }[] } };
  intent.message.to = [{ address: 'someone-else@example.com' }];
  await writeFile(file, JSON.stringify(intent, null, 2));
  await assert.rejects(s.dispatcher('worker-a').dispatch(s.id), /was altered/);
  await persistEvidence(t, s.ws, { intentIds: [s.id] });
  assert.equal((await s.transport.calls()).length, 0);
});

test('OS-POL-01 at the side effect: the policy is rechecked at dispatch; authorized at 23:50, dispatched at 00:10: 0 transport calls', async (t) => {
  const ws = await workspace('a09-policy-recheck');
  const night = bratislava('00:10', '2026-10-08');
  const day = bratislava('10:00', '2026-10-08');
  const nightStore = await SendRecordStore.init(ws.storeDir, { clock: () => night });
  const transport = await FakeTransport.create(ws.transportDir);
  const id = (await nightStore.create(intentInput({ authorization: { kind: 'policy_allow', decidedAt: bratislava('23:50').toISOString() } }))).record.intentId;
  const at = (store: SendRecordStore, clock: () => Date) =>
    new SendDispatcher({ store, transport, worker: 'worker-a', leaseMs: 5_000, beforeSubmit: policyRecheck(CONFIG, { clock, verifier: VERIFIER }) });
  const refused = await at(nightStore, () => night).dispatch(id);
  assert.deepEqual([refused.kind, refused.submitted], ['blocked', 0]);
  assert.match(refused.reason ?? '', /policy rechecked at dispatch: deny.*quiet hours/);
  assert.equal((await transport.calls()).length, 0);
  const sent = await at(new SendRecordStore(ws.storeDir, { clock: () => day }), () => day).dispatch(id);
  await persistEvidence(t, ws, { intentIds: [id] });
  assert.deepEqual([sent.kind, sent.submitted], ['observed_sent', 1], 'positive control: the same intent at 10:00');
});


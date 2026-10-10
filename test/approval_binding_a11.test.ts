/**
 * Pins G3-A11 of the independent review of 2026-10-07 (ASTRA): a changed drawing invalidates the approval.
 *
 * The approval binds tenant, job, intent, sending identity, the full recipient set, the rendered message hash, template
 * id and version, policy version, every attachment's document id, immutable revision and bytes hash, and the named
 * drawing clearances, all computed by the server from trusted state. At the dispatch boundary the gate re-reads the
 * document registry under its version fence: revision 4 after an approval at revision 3, new bytes under the same file
 * name, other recipients or body, a revoked approval, a generic or worker-supplied approval, and a policy change each
 * give 0 transport calls and a new approval (or review) requirement. The revision update raced against the dispatch has
 * its order recorded in the registry log; a change after a completed dispatch keeps the sent snapshot, marks the record
 * superseded and asks a person, never resending. Positive control: the unchanged revision gives exactly 1 call with the
 * exact bytes. Every case persists its evidence (send record, registry log, transport calls) and prints the paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSupersession, computeBinding, bindingHashOf, requestSendApproval, subjectOfInput, type ApprovalBinding } from '../src/approval_binding.js';
import type { RegistryEvent } from '../src/document_registry.js';
import { messageContentHash } from '../src/message.js';
import { createServer } from '../src/server.js';
import { escalateTo } from '../src/send_dispatcher.js';
import { describeSendState, intentIdOf, policyVersionOf, type SendRecord } from '../src/send_record.js';
import {
  CHECKS, DRAWING_ID, DRAWING_R3, DRAWING_R3_EDITED, DRAWING_R4, JOB_ID, SCOPE_ID, SCOPE_R1, addRevision4, bindingEnv, drawingSend,
  seedRegistry, sha, tool, type BindingEnv,
} from './binding_fixtures.js';
import { CONFIG, EVIDENCED } from './policy_fixtures.js';
import { KEY, Trace, persistEvidence } from './send_fixtures.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type DispatchLine = Extract<RegistryEvent, { type: 'dispatch_fence' | 'dispatch_refused' }>;

async function evidence(t: Parameters<typeof persistEvidence>[0], env: BindingEnv, ids: string[], summary: Record<string, unknown> = {}, trace?: Trace) {
  await persistEvidence(t, env.ws, {
    intentIds: ids,
    summary: { approvals: await env.queue.list(), ...summary },
    copies: [{ from: env.registryLog, name: 'registry_log.jsonl' }, { from: path.join(env.ws.root, 'approvals.jsonl'), name: 'approvals.jsonl' }],
    ...(trace ? { trace } : {}),
  });
}

/** The send record's own events and the registry log tell which came first: the dispatch check or the revision update. */
async function order(env: BindingEnv, intentId: string): Promise<{ order: 'dispatch_first' | 'update_first'; checkSeq: number; updateSeq: number }> {
  const log = await env.registry.log();
  const update = log.find((e) => e.type === 'revision_added' && e.documentId === DRAWING_ID && e.revision === '4');
  const check = log.find((e) => (e.type === 'dispatch_fence' || e.type === 'dispatch_refused') && e.intentId === intentId);
  assert.ok(update && check, 'both the update and the dispatch check are in the registry log');
  return { order: check.seq < update.seq ? 'dispatch_first' : 'update_first', checkSeq: check.seq, updateSeq: update.seq };
}

/** Whatever the order, the outcome must match it exactly. */
async function assertConsistent(env: BindingEnv, intentId: string, seen: { order: string }): Promise<SendRecord> {
  const calls = (await env.transport.calls()).filter((c) => c.correlationId === `corr-${intentId.slice(3)}`);
  const record = await checkSupersession({ store: env.store, registry: env.registry, worker: 'registry-watch', escalate: escalateTo(env.queue, 'registry-watch') }, intentId);
  if (seen.order === 'update_first') {
    assert.equal(calls.length, 0, 'the update came first: the approval was stale, nothing was sent');
    assert.ok(record.blocks.some((b) => b.reasons.some((r) => /currentRevision: "3" -> "4"/.test(r))), 'the stale diff is recorded');
    assert.equal(record.approvalChain.length, 1, 'a new approval is required');
    assert.deepEqual(record.superseded, []);
  } else {
    assert.equal(calls.length, 1, 'the dispatch came first: one call');
    const drawing = calls[0].attachments.find((a) => a.documentId === DRAWING_ID);
    assert.deepEqual([drawing?.revision, drawing?.bytesSha256], ['3', sha(DRAWING_R3)], 'the approved bytes of revision 3 left, never revision 4');
    assert.deepEqual(record.superseded.map((s) => [s.sentRevision, s.currentRevision]), [['3', '4']], 'the later change marks the sent record superseded');
  }
  return record;
}

test('A11: the binding covers tenant, job, intent, sender, recipients, rendered hash, template, policy version, revisions with byte hashes and named clearances, from trusted state', async (t) => {
  const env = await bindingEnv('a11-binding-fields');
  const input = drawingSend();
  const state = await env.registry.state();
  const pv = policyVersionOf(CONFIG);
  const { binding, hash, errors, warnings } = computeBinding(subjectOfInput(input), state, pv, 3);
  assert.deepEqual([errors, warnings], [[], []]);
  assert.deepEqual(
    [binding.tenant, binding.jobId, binding.intentId, binding.from, binding.renderedHash, binding.templateId, binding.templateVersion, binding.policyVersion],
    ['tenant-template', JOB_ID, intentIdOf(input.key), 'rfq-worker@example.com', messageContentHash(input.message), 'tpl-rfq-supplier', '3', pv],
  );
  assert.deepEqual(binding.recipients, { to: ['offers@example.com'], cc: [], bcc: ['archive@example.com'] });
  assert.deepEqual(binding.attachments.map((a) => [a.documentId, a.revision, a.sha256, a.currentRevision]), [[SCOPE_ID, '1', sha(SCOPE_R1), '1'], [DRAWING_ID, '3', sha(DRAWING_R3), '3']]);
  assert.deepEqual(binding.drawingClearances, [{ documentId: DRAWING_ID, revision: '3', checks: CHECKS }], 'the three named checks on record, in canonical (chronological) order');
  assert.equal(hash, bindingHashOf(binding));

  const m = input.message;
  const variants = [
    drawingSend({ key: { ...KEY, tenant: 'tenant-other' } }),
    drawingSend({ jobId: 'DOP-2026-002' }),
    drawingSend({ key: { ...KEY, step: 'followup-1' } }),
    drawingSend({ message: { ...m, from: { address: 'rfq-worker-2@example.com' } } }),
    drawingSend({ message: { ...m, cc: [{ address: 'cc@example.com' }] } }),
    drawingSend({ message: { ...m, body: `${m.body} Please confirm receipt.` } }),
    drawingSend({ templateVersion: '4' }),
  ];
  for (const v of variants) assert.notEqual(computeBinding(subjectOfInput(v), state, pv, 3).hash, hash);
  assert.notEqual(computeBinding(subjectOfInput(input), state, policyVersionOf({ ...CONFIG, confidentialNames: ['Partner Alpha Works'] }), 3).hash, hash, 'policy version is bound');

  // The clearances come from the registry, never from the worker: three claimed checks against two on record.
  const thin = await seedRegistry(path.join(env.ws.root, 'registry-two-checks'), 2);
  const claimed = drawingSend({ action: { category: 'drawing_release', level: 'L2', supervisor: 'M. Example', drawingChecks: CHECKS.map((c) => ({ documentId: DRAWING_ID, revision: '3', ...c })) } });
  assert.match(computeBinding(subjectOfInput(claimed), await thin.state(), pv, 3).errors.join('; '), /has 2 of 3 named checks recorded in the registry/);
  await assert.rejects(requestSendApproval({ approvals: env.queue, registry: thin, policy: CONFIG, requestedBy: 'worker-a' }, subjectOfInput(claimed), []), /has 2 of 3 named checks/);
  await evidence(t, env, []);
});

test('A11 positive control: the revision is unchanged at dispatch: exactly 1 transport call with the exact approved bytes', async (t) => {
  const env = await bindingEnv('a11-positive');
  const { id, approvalId, bindingHash } = await env.approvedIntent(drawingSend());
  const out = await env.dispatcher('worker-a').dispatch(id);
  await evidence(t, env, [id]);
  assert.deepEqual([out.kind, out.submitted], ['observed_sent', 1]);
  const calls = await env.transport.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.fromEntries(calls[0].attachments.map((a) => [a.documentId, a.bytesSha256])), { [SCOPE_ID]: sha(SCOPE_R1), [DRAWING_ID]: sha(DRAWING_R3) });
  const attempt = out.record.attempts[0];
  assert.equal(attempt.bindingHash, bindingHash);
  const fence = (await env.registry.log()).find((e) => e.type === 'dispatch_fence');
  assert.equal(attempt.registrySeq, fence?.seq);
  assert.deepEqual(attempt.attachmentBytes?.map((a) => a.sha256), [sha(SCOPE_R1), sha(DRAWING_R3)]);
  const view = await env.queue.get(approvalId);
  assert.deepEqual([view?.status, view?.decision?.decidedBy, view?.decision?.approverId, view?.decision?.bindingHash], ['approved', 'M. Example', 'approver-1', bindingHash]);
});

test('A11: revision 4 after an approval at revision 3, before dispatch: 0 transport calls and a new approval requirement', async (t) => {
  const env = await bindingEnv('a11-revision-4');
  const { id, approvalId } = await env.approvedIntent(drawingSend());
  await addRevision4(env.registry);
  const out = await env.dispatcher('worker-a').dispatch(id);
  assert.deepEqual([out.kind, out.submitted], ['blocked', 0]);
  assert.match(out.reason ?? '', new RegExp(`stale approval ${approvalId}: attachments\\[doc-0101\\]\\.currentRevision: "3" -> "4"`));
  assert.equal((await env.transport.calls()).length, 0);
  const [next] = out.record.approvalChain;
  assert.ok(next && next.approvalId !== approvalId && next.bindingHash.length === 64, 'a new approval with a fresh binding is required');
  const fresh = await env.queue.get(next.approvalId);
  assert.equal(fresh?.status, 'pending');
  assert.equal((fresh?.binding as ApprovalBinding).attachments.find((a) => a.documentId === DRAWING_ID)?.currentRevision, '4');
  assert.match(fresh?.reasons.join(' ') ?? '', /carries revision 3, revision 4 is current/);

  const again = await env.dispatcher('worker-b').dispatch(id);
  assert.deepEqual([again.kind, again.submitted], ['blocked', 0]);
  assert.match(again.reason ?? '', /pending: a person has not decided yet/);
  assert.equal((await env.queue.list('pending')).length, 1, 'no further request while one is pending');
  await env.decide(next.approvalId, 'rejected');
  const rejected = await env.dispatcher('worker-b').dispatch(id);
  await evidence(t, env, [id]);
  assert.match(rejected.reason ?? '', /was rejected by M\. Example: nothing is sent/);
  assert.equal((await env.transport.calls()).length, 0);
});

test('A11: new bytes under the same file name and revision label: 0 transport calls and a review requirement', async (t) => {
  const env = await bindingEnv('a11-bytes-replaced');
  const { id, approvalId } = await env.approvedIntent(drawingSend());
  await env.registry.replaceBytes(DRAWING_ID, '3', DRAWING_R3_EDITED, 'someone-else');
  const out = await env.dispatcher('worker-a').dispatch(id);
  assert.deepEqual([out.kind, out.submitted], ['blocked', 0]);
  assert.match(out.reason ?? '', /new bytes under the same file name/);
  assert.match(out.reason ?? '', new RegExp(`stale approval ${approvalId}: attachments\\[doc-0101\\]\\.sha256`));
  const [review] = out.record.approvalChain;
  assert.equal(review.bindingHash, '', 'a review: the stored message cannot be approved as it stands');
  const request = await env.queue.get(review.approvalId);
  assert.equal(request?.binding, undefined);
  assert.match(request?.reasons.join(' ') ?? '', /cannot authorize a send/);
  const again = await env.dispatcher('worker-b').dispatch(id);
  await evidence(t, env, [id]);
  assert.match(again.reason ?? '', /review .* the stored message cannot be sent/);
  assert.equal((await env.queue.list()).length, 2, 'no further request');
  assert.equal((await env.transport.calls()).length, 0);
});

test('A11: other recipients or another body cannot ride on an approval; a regenerated draft of the approved intent changes nothing', async (t) => {
  const env = await bindingEnv('a11-recipients-body');
  const approved = await env.approvedIntent(drawingSend());
  const m = drawingSend().message;
  const otherTo = await env.store.create(drawingSend({ key: { ...KEY, step: 'initial-b' }, message: { ...m, to: [{ address: 'cc@example.com' }] }, authorization: { kind: 'approval', approvalId: approved.approvalId } }));
  const toOut = await env.dispatcher('worker-a').dispatch(otherTo.record.intentId);
  assert.deepEqual([toOut.kind, toOut.submitted], ['blocked', 0]);
  for (const field of [/intentId/, /recipients\.to\[0\]: "offers@example\.com" -> "cc@example\.com"/, /renderedHash/]) assert.match(toOut.reason ?? '', field);
  const otherBody = await env.store.create(drawingSend({ key: { ...KEY, step: 'initial-c' }, message: { ...m, body: `${m.body}\nPlease also quote painting.` }, authorization: { kind: 'approval', approvalId: approved.approvalId } }));
  const bodyOut = await env.dispatcher('worker-a').dispatch(otherBody.record.intentId);
  assert.deepEqual([bodyOut.kind, bodyOut.submitted], ['blocked', 0]);
  assert.match(bodyOut.reason ?? '', /renderedHash/);
  assert.equal((await env.transport.calls()).length, 0);

  const redraft = await env.store.create(drawingSend({ createdBy: { worker: 'worker-b', task: 'task-b-2' }, message: { ...m, body: 'A regenerated body.' }, authorization: { kind: 'approval', approvalId: approved.approvalId } }));
  assert.equal(redraft.created, false, 'a regenerated draft of the approved intent is suppressed');
  const sent = await env.dispatcher('worker-a').dispatch(approved.id);
  await evidence(t, env, [approved.id, otherTo.record.intentId, otherBody.record.intentId]);
  assert.deepEqual([sent.kind, sent.submitted], ['observed_sent', 1]);
  assert.equal((await env.transport.calls())[0].contentHash, messageContentHash(m), 'the approved rendering left');
});

test('A11: a revoked approval sends nothing and calls for a new approval', async (t) => {
  const env = await bindingEnv('a11-revoked');
  const { id, approvalId } = await env.approvedIntent(drawingSend());
  await env.decide(approvalId, 'revoked');
  const view = await env.queue.get(approvalId);
  assert.deepEqual([view?.status, view?.revocation?.revokedBy, view?.revocation?.approverId], ['revoked', 'M. Example', 'approver-1']);
  await assert.rejects(env.decide(approvalId, 'revoked'), /is revoked: only an approved request can be revoked/);
  const out = await env.dispatcher('worker-a').dispatch(id);
  await evidence(t, env, [id]);
  assert.deepEqual([out.kind, out.submitted], ['blocked', 0]);
  assert.match(out.reason ?? '', new RegExp(`approval ${approvalId} was revoked by M\\. Example`));
  assert.equal(out.record.approvalChain.length, 1);
  assert.equal((await env.transport.calls()).length, 0);
});

test('A11: a generic approval, a worker-supplied payload or drawingChecks=3 does not pass', async (t) => {
  const env = await bindingEnv('a11-generic');
  const input = drawingSend();
  const { binding, hash } = computeBinding(subjectOfInput(input), await env.registry.state(), policyVersionOf(CONFIG), 3);
  const worker = await createServer({ stateDir: env.ws.root, role: 'agent', caller: 'worker-1', policy: CONFIG });
  const filed = (await tool(worker.tools, 'approval_request').handler({ category: 'drawing_release', summary: 'Release the drawing', payload: { binding, bindingHash: hash }, jobId: JOB_ID })) as { id: string };
  await env.decide(filed.id, 'approved');
  assert.equal((await env.queue.get(filed.id))?.status, 'approved', 'a person approved it');
  const id = (await env.store.create({ ...input, authorization: { kind: 'approval', approvalId: filed.id } })).record.intentId;
  const out = await env.dispatcher('worker-a').dispatch(id);
  assert.deepEqual([out.kind, out.submitted], ['blocked', 0]);
  assert.match(out.reason ?? '', /carries no binding computed by the server: a generic approval or a worker-supplied payload does not authorize a send/);
  assert.equal(out.record.approvalChain.length, 1, 'a proper approval with a server binding is requested instead');
  assert.equal((await env.queue.get(out.record.approvalChain[0].approvalId))?.bindingHash, hash);
  // A plain decision that does not name the binding cannot approve a bound request, even inside the server.
  await assert.rejects(env.queue.decide(out.record.approvalChain[0].approvalId, 'approved', 'M. Example'), new RegExp(`binds ${hash}; the decision names no binding`));

  // drawingChecks=3 claimed by the worker while the registry records 2 checks: nothing leaves, autonomous or approved.
  const thin = await bindingEnv('a11-claimed-checks', { checks: 2 });
  const claimed = drawingSend({
    key: { ...KEY, packageId: 'ACME-PKG-1102' },
    action: { category: 'supplier_inquiry', level: 'L2', supervisor: 'M. Example', drawingChecks: CHECKS.map((c) => ({ documentId: DRAWING_ID, revision: '3', ...c })) },
  });
  const autonomous = (await thin.store.create(claimed)).record.intentId;
  const refused = await thin.dispatcher('worker-a').dispatch(autonomous);
  await evidence(t, env, [id]);
  await evidence(t, thin, [autonomous]);
  assert.deepEqual([refused.kind, refused.submitted], ['blocked', 0]);
  assert.match(refused.reason ?? '', /has 2 of 3 named checks recorded in the registry/);
  await assert.rejects(requestSendApproval({ approvals: thin.queue, registry: thin.registry, policy: CONFIG, requestedBy: 'worker-a' }, subjectOfInput(claimed), []), /has 2 of 3/);
  const check = tool(worker.tools, 'policy_check');
  assert.throws(() => check.inputSchema.parse({ ...EVIDENCED, drawingChecks: 3 }));
  assert.equal((await thin.transport.calls()).length + (await env.transport.calls()).length, 0);
});

test('A11: without the approval-binding gate an approved send or a drawing does not leave (fail closed at the dispatcher)', async (t) => {
  const env = await bindingEnv('a11-no-gate');
  const { id } = await env.approvedIntent(drawingSend());
  const autonomousDrawing = (await env.store.create(drawingSend({ key: { ...KEY, packageId: 'ACME-PKG-1401' }, action: { category: 'supplier_inquiry', level: 'L2', supervisor: 'M. Example', disclosureRendered: true } }))).record.intentId;
  for (const intentId of [id, autonomousDrawing]) {
    const out = await env.dispatcher('worker-a', { gate: undefined }).dispatch(intentId);
    assert.deepEqual([out.kind, out.submitted], ['blocked', 0]);
    assert.match(out.reason ?? '', /no approval-binding gate is configured/);
  }
  await evidence(t, env, [id, autonomousDrawing]);
  assert.equal((await env.transport.calls()).length, 0);
});

test('A11: a policy change after the approval makes it stale (the policy version is bound)', async (t) => {
  const env = await bindingEnv('a11-policy-version');
  const { id, approvalId } = await env.approvedIntent(drawingSend());
  const changed = { ...CONFIG, confidentialNames: [...(CONFIG.confidentialNames ?? []), 'Gamma Works'] };
  const out = await env.dispatcher('worker-a', {}, changed).dispatch(id);
  await evidence(t, env, [id]);
  assert.deepEqual([out.kind, out.submitted], ['blocked', 0]);
  assert.match(out.reason ?? '', new RegExp(`stale approval ${approvalId}: policyVersion`));
});

test('A11: a revision update raced against dispatch under the registry version fence: the order is recorded and each outcome matches it', async (t) => {
  // Update first, deterministically.
  const first = await bindingEnv('a11-race-update-first');
  const a = await first.approvedIntent(drawingSend());
  await addRevision4(first.registry);
  await first.dispatcher('worker-a').dispatch(a.id);
  const o1 = await order(first, a.id);
  assert.equal(o1.order, 'update_first');
  await assertConsistent(first, a.id, o1);
  await evidence(t, first, [a.id], { order: o1 });

  // Dispatch first, deterministically: the update lands right after the fence, before the transport call.
  const second = await bindingEnv('a11-race-dispatch-first');
  const b = await second.approvedIntent(drawingSend());
  await second.dispatcher('worker-a', { onPoint: async (point) => { if (point === 'after_submit_started') await addRevision4(second.registry); } }).dispatch(b.id);
  const o2 = await order(second, b.id);
  assert.equal(o2.order, 'dispatch_first');
  await assertConsistent(second, b.id, o2);
  await evidence(t, second, [b.id], { order: o2 });

  // A free race, round after round: whichever wins, the outcome matches the recorded order.
  const tally = { update_first: 0, dispatch_first: 0 };
  const rounds: unknown[] = [];
  for (let round = 1; round <= 12; round += 1) {
    const env = await bindingEnv(`a11-race-free-${round}`);
    const { id } = await env.approvedIntent(drawingSend());
    await Promise.all([
      env.dispatcher('worker-a').dispatch(id),
      (async () => {
        await sleep(Math.floor(Math.random() * 41));
        await addRevision4(env.registry);
      })(),
    ]);
    const o = await order(env, id);
    await assertConsistent(env, id, o);
    tally[o.order] += 1;
    rounds.push({ round, ...o, calls: (await env.transport.calls()).length });
    await evidence(t, env, [id], { round, order: o });
  }
  t.diagnostic(`free race over 12 rounds: update first ${tally.update_first}, dispatch first ${tally.dispatch_first}`);
  t.diagnostic(`rounds: ${JSON.stringify(rounds)}`);
});

const UPDATER = fileURLToPath(new URL('./fixtures/registry_update.js', import.meta.url));

test('A11 across processes: a registry update in another OS process raced against a dispatch: the order is recorded and each outcome matches it', async (t) => {
  const tally = { update_first: 0, dispatch_first: 0 };
  for (let round = 1; round <= 6; round += 1) {
    const env = await bindingEnv(`a11-race-process-${round}`);
    const trace = new Trace();
    const { id } = await env.approvedIntent(drawingSend());
    const barrierPath = path.join(env.ws.root, 'barrier');
    const configPath = path.join(env.ws.root, 'updater.json');
    await writeFile(configPath, JSON.stringify({
      registryDir: path.dirname(env.registryLog), barrierPath, documentId: DRAWING_ID, revision: '4', filename: 'hall_frame_rev4.pdf', kind: 'drawing',
      bytes: Buffer.from(DRAWING_R4).toString('base64'), maxDelayMs: 8,
    }));
    const child = spawn(process.execPath, [UPDATER, configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    trace.note(`spawn registry updater pid ${child.pid}`);
    let out = '';
    let err = '';
    child.stderr.on('data', (c) => (err += c));
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (c) => {
        out += c;
        if (out.includes('ready\n')) resolve();
      });
      child.on('exit', (code) => (out.includes('ready\n') ? undefined : reject(new Error(`updater exited ${code}: ${err}`))));
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    await ready;
    await writeFile(barrierPath, 'go\n');
    trace.note('barrier opened; dispatching');
    await env.dispatcher('worker-a').dispatch(id);
    assert.equal(await exited, 0, err);
    trace.note(`updater says ${out.trim().split('\n').pop()}`);
    const o = await order(env, id);
    await assertConsistent(env, id, o);
    tally[o.order] += 1;
    await evidence(t, env, [id], { round, order: o }, trace);
  }
  t.diagnostic(`cross-process race over 6 rounds: update first ${tally.update_first}, dispatch first ${tally.dispatch_first}`);
});

test('A11: a revocation raced against dispatch: the gate reads the approval under the queue lock, so the fence line records which came first', async (t) => {
  const tally = { revoked_first: 0, dispatch_first: 0 };
  for (let round = 1; round <= 10; round += 1) {
    const env = await bindingEnv(`a11-revoke-race-${round}`);
    const { id, approvalId } = await env.approvedIntent(drawingSend());
    await Promise.all([
      env.dispatcher('worker-a').dispatch(id),
      (async () => {
        await sleep(Math.floor(Math.random() * 41));
        await env.decide(approvalId, 'revoked');
      })(),
    ]);
    const check = (await env.registry.log()).find((e): e is DispatchLine => (e.type === 'dispatch_fence' || e.type === 'dispatch_refused') && e.intentId === id);
    const calls = await env.transport.calls();
    const view = await env.queue.get(approvalId);
    assert.ok(check && view?.revocation);
    assert.equal(view.status, 'revoked');
    if (check.type === 'dispatch_fence') {
      assert.equal(check.approval?.status, 'approved', 'the gate saw the approval before the revocation');
      assert.equal(calls.length, 1);
      assert.ok(Date.parse(view.revocation.revokedAt) >= Date.parse(check.at), 'the revocation was recorded after the fence line');
      tally.dispatch_first += 1;
    } else {
      assert.equal(check.approval?.status, 'revoked', 'the gate saw the revocation');
      assert.equal(calls.length, 0);
      tally.revoked_first += 1;
    }
    await evidence(t, env, [id], { round, fenceLine: check });
  }
  t.diagnostic(`revocation race over 10 rounds: revoked first ${tally.revoked_first}, dispatch first ${tally.dispatch_first}`);
});

test('A11: a change after a completed dispatch cannot unsend: the sent snapshot stays, the record is superseded, a person is asked, nothing is resent', async (t) => {
  const env = await bindingEnv('a11-superseded');
  const { id } = await env.approvedIntent(drawingSend());
  const sent = await env.dispatcher('worker-a').dispatch(id);
  assert.deepEqual([sent.kind, sent.submitted], ['observed_sent', 1]);
  const before = sent.record;
  const changeSeq = await addRevision4(env.registry);
  const watch = { store: env.store, registry: env.registry, worker: 'registry-watch', escalate: escalateTo(env.queue, 'registry-watch') };
  const marked = await checkSupersession(watch, id);
  assert.deepEqual(marked.superseded.map((s) => [s.documentId, s.sentRevision, s.currentRevision, s.sentSha256, s.currentSha256, s.changeSeq]), [[DRAWING_ID, '3', '4', sha(DRAWING_R3), sha(DRAWING_R4), changeSeq]]);
  assert.ok(marked.superseded[0].dispatchSeq < changeSeq);
  assert.ok(marked.superseded[0].approvalId, 'a person is asked');
  assert.equal((await env.queue.get(marked.superseded[0].approvalId!))?.status, 'pending');
  assert.equal(marked.state, 'observed_sent', 'what was sent stays sent');
  assert.deepEqual(marked.attempts, before.attempts, 'the sent snapshot (attempt, bytes hashes, binding) is unchanged');
  assert.match(describeSendState(marked), /superseded after dispatch .*nothing is resent/);
  assert.equal((await checkSupersession(watch, id)).superseded.length, 1, 'idempotent');
  const again = await env.dispatcher('worker-a').dispatch(id);
  await evidence(t, env, [id]);
  assert.deepEqual([again.kind, again.submitted], ['already_sent', 0]);
  assert.equal((await env.transport.calls()).length, 1, 'no resend is invented');
});

test('A11 autonomous path: a policy-allowed send whose drawing changed before dispatch goes to a person; unchanged it leaves with the exact bytes', async (t) => {
  const env = await bindingEnv('a11-autonomous');
  const auto = (packageId: string) => drawingSend({
    key: { ...KEY, packageId },
    action: { category: 'supplier_inquiry', level: 'L2', supervisor: 'M. Example', disclosureRendered: true, drawingChecks: CHECKS.map((c) => ({ documentId: DRAWING_ID, revision: '3', ...c })) },
  });
  const unchanged = (await env.store.create(auto('ACME-PKG-1201'))).record.intentId;
  const ok = await env.dispatcher('worker-a').dispatch(unchanged);
  assert.deepEqual([ok.kind, ok.submitted], ['observed_sent', 1]);
  assert.equal((await env.transport.calls())[0].attachments.find((a) => a.documentId === DRAWING_ID)?.bytesSha256, sha(DRAWING_R3));

  const changed = (await env.store.create(auto('ACME-PKG-1202'))).record.intentId;
  await addRevision4(env.registry);
  const refused = await env.dispatcher('worker-a').dispatch(changed);
  assert.deepEqual([refused.kind, refused.submitted], ['blocked', 0]);
  assert.match(refused.reason ?? '', /revision 4 is current, the message carries revision 3; a changed drawing ends the autonomous permission/);
  const [requested] = refused.record.approvalChain;
  // The person decides with the exact binding in front of them; here they knowingly approve revision 3.
  await env.decide(requested.approvalId, 'approved');
  const released = await env.dispatcher('worker-a').dispatch(changed);
  await evidence(t, env, [unchanged, changed]);
  assert.deepEqual([released.kind, released.submitted], ['observed_sent', 1]);
  const calls = await env.transport.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].attachments.find((a) => a.documentId === DRAWING_ID)?.bytesSha256, sha(DRAWING_R3), 'exactly the approved bytes');
  assert.equal(released.record.attempts[0].bindingHash, requested.bindingHash);
});

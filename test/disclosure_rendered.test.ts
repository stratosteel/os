/**
 * Pins the rendered disclosure for autonomous sends (OS-POL-03 of the independent review of 2026-10-07:
 * "disclosureRequired=true is a requirement signal, not proof the outgoing message contains the approved line").
 *
 * An L2 allow needs the instance's configured, versioned disclosure line in the rendered body; the policy checks the body
 * itself and reports the version it found. A missing or altered line, an absent configuration or a placeholder without
 * a value fails closed (ask), whatever the worker's disclosureRendered claim says; the template ships no wording. At the
 * side effect the dispatcher rechecks the stored body: without the line 0 transport calls, with it exactly 1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as policy from '../src/policy.js';
import type { PolicyConfig, PolicyResult } from '../src/policy.js';
import { createServer } from '../src/server.js';
import { SendDispatcher, policyRecheck } from '../src/send_dispatcher.js';
import { FakeTransport } from '../src/transport.js';
import { CONFIG, EVIDENCED, TRUSTED, VERIFIER, bratislava } from './policy_fixtures.js';
import { KEY, initStore, intentInput, persistEvidence, workspace } from './send_fixtures.js';

const LINE = 'This message was prepared and sent by an AI system of Template Company; a named person is responsible and can be reached at rfq@example.com.';

function askedFor(r: PolicyResult, pattern: RegExp): void {
  assert.equal(r.decision, 'ask', `expected ask, got ${r.decision}: ${r.reasons.join('; ')}`);
  assert.ok(r.reasons.some((x) => pattern.test(x)), `no reason matches ${pattern}: ${r.reasons.join('; ')}`);
}

test('disclosure: an L2 allow needs the configured, versioned line in the rendered body, and reports the version it found', () => {
  assert.ok(EVIDENCED.text?.includes(LINE), 'the fixture message renders the configured line');
  const r = policy.decide(EVIDENCED, CONFIG, TRUSTED);
  assert.deepEqual([r.decision, r.disclosureRequired, r.disclosureVersion], ['allow', true, 'disclosure-en-v1']);
  const wrapped = policy.decide({ ...EVIDENCED, text: `Please quote the attached scope.\n\n${LINE.replace('; a named', ';\na named')}` }, CONFIG, TRUSTED);
  assert.equal(wrapped.decision, 'allow', 'a line break inside the line does not matter');
});

test('disclosure: a missing or altered line asks, whatever disclosureRendered claims', () => {
  askedFor(policy.decide({ ...EVIDENCED, text: 'Please quote the attached scope by 2026-10-14.', disclosureRendered: true }, CONFIG, TRUSTED), /rendered body does not carry the approved disclosure line \(version disclosure-en-v1\)/);
  askedFor(policy.decide({ ...EVIDENCED, text: LINE.replace('Template Company', 'Another Company'), disclosureRendered: true }, CONFIG, TRUSTED), /does not carry the approved disclosure line/);
  askedFor(policy.decide({ ...EVIDENCED, text: LINE.replace('rfq@example.com', 'someone@example.com') }, CONFIG, TRUSTED), /does not carry the approved disclosure line/);
  askedFor(policy.decide({ ...EVIDENCED, text: undefined }, CONFIG, TRUSTED), /does not carry the approved disclosure line/);
});

test('disclosure: an absent or incomplete configuration fails closed; the template ships no wording', () => {
  assert.equal(policy.DEFAULT_POLICY.disclosure, undefined, 'the lawyer confirms the wording; each instance configures it');
  const absent = { ...CONFIG } as PolicyConfig;
  delete absent.disclosure;
  askedFor(policy.decide(EVIDENCED, absent, TRUSTED), /disclosure configuration is absent/);
  askedFor(policy.decide(EVIDENCED, { ...CONFIG, disclosure: { version: ' ', line: policy.DISCLOSURE_LINE_EN, values: { company: 'Template Company', contact: 'rfq@example.com' } } }, TRUSTED), /disclosure configuration is absent/);
  askedFor(policy.decide(EVIDENCED, { ...CONFIG, disclosure: { version: 'disclosure-en-v1', line: policy.DISCLOSURE_LINE_EN, values: { company: 'Template Company' } } }, TRUSTED), /cannot be rendered: \{contact\} has no value/);
  // Internal work and asks are unaffected: the requirement binds the autonomous external path only.
  assert.equal(policy.decide({ category: 'draft', level: 'L1', external: false }, absent).decision, 'allow');
});

test('disclosure: {supervisor} is rendered from the named supervisor of the message', () => {
  const config: PolicyConfig = { ...CONFIG, disclosure: { version: 'disclosure-en-v2', line: 'Operations Desk (AI) of {company}, supervised by {supervisor}.', values: { company: 'Template Company' } } };
  const body = (who: string) => `Please quote the attached scope.\n\nOperations Desk (AI) of Template Company, supervised by ${who}.`;
  const r = policy.decide({ ...EVIDENCED, text: body('M. Example') }, config, TRUSTED);
  assert.deepEqual([r.decision, r.disclosureVersion], ['allow', 'disclosure-en-v2']);
  askedFor(policy.decide({ ...EVIDENCED, text: body('Somebody Else') }, config, TRUSTED), /does not carry the approved disclosure line \(version disclosure-en-v2\)/);
  askedFor(policy.decide({ ...EVIDENCED, supervisor: undefined, text: body('M. Example') }, config, TRUSTED), /no named supervisor|cannot be rendered/);
});

test('disclosure at the side effect: an autonomous send whose stored body lacks the line is refused at dispatch (0 calls); with it, exactly 1 call', async (t) => {
  const ws = await workspace('disclosure-dispatch');
  const store = await initStore(ws);
  const transport = await FakeTransport.create(ws.transportDir);
  const day = bratislava('10:00', '2026-10-08');
  const dispatcher = new SendDispatcher({ store, transport, worker: 'worker-a', leaseMs: 5_000, beforeSubmit: policyRecheck(CONFIG, { clock: () => day, verifier: VERIFIER }) });
  const base = intentInput();
  const without = (await store.create(intentInput({ key: { ...KEY, packageId: 'ACME-PKG-1301' }, message: { ...base.message, body: 'Please quote the attached scope by 2026-10-20.' } }))).record.intentId;
  const refused = await dispatcher.dispatch(without);
  assert.deepEqual([refused.kind, refused.submitted], ['blocked', 0]);
  assert.match(refused.reason ?? '', /does not carry the approved disclosure line/);
  const withLine = (await store.create(intentInput({ key: { ...KEY, packageId: 'ACME-PKG-1302' } }))).record.intentId;
  const sent = await dispatcher.dispatch(withLine);
  await persistEvidence(t, ws, { intentIds: [without, withLine] });
  assert.deepEqual([sent.kind, sent.submitted], ['observed_sent', 1]);
  const calls = await transport.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].correlationId, sent.record.intent.correlationId);
});

test('disclosure through the access door: policy_check reports the verified disclosure version', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'os-disclosure-'));
  const { tools } = await createServer({ stateDir: dir, policy: CONFIG, clock: () => bratislava('10:00'), verifier: VERIFIER });
  const check = tools.find((x) => x.name === 'policy_check');
  assert.ok(check);
  const r = (await check.handler({ ...EVIDENCED })) as PolicyResult;
  assert.deepEqual([r.decision, r.disclosureVersion], ['allow', 'disclosure-en-v1']);
  askedFor((await check.handler({ ...EVIDENCED, text: 'No disclosure here.' })) as PolicyResult, /does not carry the approved disclosure line/);
});

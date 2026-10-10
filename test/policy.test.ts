import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, DEFAULT_POLICY, inQuietHours, findConfidentialNames, type PolicyConfig } from '../src/policy.js';
import { CHECKS, CONFIG, DRAWING, EVIDENCED, TRUSTED, bratislava } from './policy_fixtures.js';

/** A message in an approved template to a registered counterparty and recipient, with its evidence. localTime is only a claim. */
const base = { ...EVIDENCED, localTime: '10:00' };
/** What the server passes: its own trusted clock reading at 10:00 local and the evidence verifier. */
const day = TRUSTED;

test('reads are always allowed, even at L0 and internal', () => {
  assert.equal(decide({ category: 'read', level: 'L0', external: false }).decision, 'allow');
});

test('L0 observes only: an internal note at L0 needs a person', () => {
  assert.equal(decide({ category: 'internal_note', level: 'L0', external: false }).decision, 'ask');
  assert.equal(decide({ category: 'internal_note', level: 'L1', external: false }).decision, 'allow');
  assert.equal(decide({ category: 'draft', level: 'L1', external: false }).decision, 'allow');
});

test('L2 supplier inquiry inside approved template and register is autonomous, with disclosure', () => {
  const r = decide({ ...base, category: 'supplier_inquiry', level: 'L2' }, CONFIG, day);
  assert.equal(r.decision, 'allow');
  assert.equal(r.disclosureRequired, true);
});

test('L2 supplier follow-up is autonomous; L1 is not', () => {
  assert.equal(decide({ ...base, category: 'supplier_followup', level: 'L2' }, CONFIG, day).decision, 'allow');
  assert.equal(decide({ ...base, category: 'supplier_followup', level: 'L1' }, CONFIG, day).decision, 'ask');
});

test('customer quotes, prices, orders, contracts and new counterparties always ask, even at L3', () => {
  for (const category of ['customer_quote', 'price', 'order', 'contract', 'new_counterparty'] as const) {
    const r = decide({ ...base, category, level: 'L3' }, CONFIG, day);
    assert.equal(r.decision, 'ask', category);
  }
});

test('a supplier inquiry that states our price asks', () => {
  assert.equal(decide({ ...base, category: 'supplier_inquiry', level: 'L2', statesOurPrice: true }, CONFIG, day).decision, 'ask');
});

test('unknown recipient or counterparty outside the register asks', () => {
  assert.equal(decide({ ...base, category: 'supplier_inquiry', level: 'L2', recipientKnown: false }, CONFIG, day).decision, 'ask');
  assert.equal(decide({ ...base, category: 'supplier_inquiry', level: 'L2', counterpartyInRegister: false }, CONFIG, day).decision, 'ask');
});

test('template not approved by a person asks', () => {
  assert.equal(decide({ ...base, category: 'supplier_inquiry', level: 'L2', templateApproved: false }, CONFIG, day).decision, 'ask');
});

test('external sending in quiet hours is denied', () => {
  const at = (hhmm: string) => decide({ ...base, category: 'supplier_inquiry', level: 'L2' }, CONFIG, { ...day, now: bratislava(hhmm, '2026-10-08') }).decision;
  assert.equal(at('00:30'), 'deny');
  assert.equal(at('05:59'), 'deny');
  assert.equal(at('06:00'), 'allow');
  assert.equal(inQuietHours('23:59', DEFAULT_POLICY.quietHours), false);
  assert.equal(inQuietHours('00:00', DEFAULT_POLICY.quietHours), true);
});

test('a drawing leaves only after 3 checks', () => {
  const drawing = { ...base, attachments: [DRAWING] };
  assert.equal(decide({ ...drawing, category: 'drawing_release', level: 'L2', drawingChecks: CHECKS.slice(0, 2) }, CONFIG, day).decision, 'deny');
  assert.equal(decide({ ...drawing, category: 'supplier_inquiry', level: 'L2', drawingChecks: CHECKS.slice(0, 2) }, CONFIG, day).decision, 'deny');
  assert.equal(decide({ ...drawing, category: 'supplier_inquiry', level: 'L2', drawingChecks: CHECKS }, CONFIG, day).decision, 'allow');
});

test('confidential names never leave: deny before anything else', () => {
  const names = ['Partner Alpha Works', 'Beta Foundry'];
  const cfg: PolicyConfig = { ...CONFIG, confidentialNames: names };
  const r = decide({ ...base, category: 'supplier_inquiry', level: 'L2', text: 'Quote based on Beta Foundry pattern' }, cfg, day);
  assert.equal(r.decision, 'deny');
  assert.deepEqual(findConfidentialNames('we use PARTNER ALPHA works', names), ['Partner Alpha Works']);
  assert.deepEqual(findConfidentialNames('no names here', names), []);
});

test('L3 external autonomy is not enabled: asks', () => {
  assert.equal(decide({ ...base, category: 'send_external', level: 'L3' }, CONFIG, day).decision, 'ask');
});

test('every external decision requires disclosure, internal ones do not', () => {
  assert.equal(decide({ ...base, category: 'supplier_inquiry', level: 'L2' }, CONFIG, day).disclosureRequired, true);
  assert.equal(decide({ category: 'draft', level: 'L1', external: false }).disclosureRequired, false);
});

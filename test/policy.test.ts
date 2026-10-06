import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, DEFAULT_POLICY, inQuietHours, findConfidentialNames, type PolicyConfig } from '../src/policy.js';

const base = { external: true, counterpartyInRegister: true, recipientKnown: true, templateApproved: true, localTime: '10:00' } as const;

test('reads are always allowed, even at L0 and internal', () => {
  assert.equal(decide({ category: 'read', level: 'L0', external: false }).decision, 'allow');
});

test('L0 observes only: an internal note at L0 needs a person', () => {
  assert.equal(decide({ category: 'internal_note', level: 'L0', external: false }).decision, 'ask');
  assert.equal(decide({ category: 'internal_note', level: 'L1', external: false }).decision, 'allow');
  assert.equal(decide({ category: 'draft', level: 'L1', external: false }).decision, 'allow');
});

test('L2 supplier inquiry inside approved template and register is autonomous, with disclosure', () => {
  const r = decide({ ...base, category: 'supplier_inquiry', level: 'L2' });
  assert.equal(r.decision, 'allow');
  assert.equal(r.disclosureRequired, true);
});

test('L2 supplier follow-up is autonomous; L1 is not', () => {
  assert.equal(decide({ ...base, category: 'supplier_followup', level: 'L2' }).decision, 'allow');
  assert.equal(decide({ ...base, category: 'supplier_followup', level: 'L1' }).decision, 'ask');
});

test('customer quotes, prices, orders, contracts and new counterparties always ask, even at L3', () => {
  for (const category of ['customer_quote', 'price', 'order', 'contract', 'new_counterparty'] as const) {
    const r = decide({ ...base, category, level: 'L3' });
    assert.equal(r.decision, 'ask', category);
  }
});

test('a supplier inquiry that states our price asks', () => {
  assert.equal(decide({ ...base, category: 'supplier_inquiry', level: 'L2', statesOurPrice: true }).decision, 'ask');
});

test('unknown recipient or counterparty outside the register asks', () => {
  assert.equal(decide({ ...base, category: 'supplier_inquiry', level: 'L2', recipientKnown: false }).decision, 'ask');
  assert.equal(decide({ ...base, category: 'supplier_inquiry', level: 'L2', counterpartyInRegister: false }).decision, 'ask');
});

test('template not approved by a person asks', () => {
  assert.equal(decide({ ...base, category: 'supplier_inquiry', level: 'L2', templateApproved: false }).decision, 'ask');
});

test('external sending in quiet hours is denied', () => {
  assert.equal(decide({ ...base, category: 'supplier_inquiry', level: 'L2', localTime: '00:30' }).decision, 'deny');
  assert.equal(decide({ ...base, category: 'supplier_inquiry', level: 'L2', localTime: '05:59' }).decision, 'deny');
  assert.equal(decide({ ...base, category: 'supplier_inquiry', level: 'L2', localTime: '06:00' }).decision, 'allow');
  assert.equal(inQuietHours('23:59', DEFAULT_POLICY.quietHours), false);
  assert.equal(inQuietHours('00:00', DEFAULT_POLICY.quietHours), true);
});

test('a drawing leaves only after 3 checks', () => {
  assert.equal(decide({ ...base, category: 'drawing_release', level: 'L2', drawingChecks: 2 }).decision, 'deny');
  assert.equal(decide({ ...base, category: 'supplier_inquiry', level: 'L2', drawingChecks: 2 }).decision, 'deny');
  assert.equal(decide({ ...base, category: 'supplier_inquiry', level: 'L2', drawingChecks: 3 }).decision, 'allow');
});

test('confidential names never leave: deny before anything else', () => {
  const cfg: PolicyConfig = { ...DEFAULT_POLICY, confidentialNames: ['Partner Alpha Works', 'Beta Foundry'] };
  const r = decide({ ...base, category: 'supplier_inquiry', level: 'L2', text: 'Quote based on Beta Foundry pattern' }, cfg);
  assert.equal(r.decision, 'deny');
  assert.deepEqual(findConfidentialNames('we use PARTNER ALPHA works', cfg.confidentialNames), ['Partner Alpha Works']);
  assert.deepEqual(findConfidentialNames('no names here', cfg.confidentialNames), []);
});

test('L3 external autonomy is not enabled: asks', () => {
  assert.equal(decide({ ...base, category: 'send_external', level: 'L3' }).decision, 'ask');
});

test('every external decision requires disclosure, internal ones do not', () => {
  assert.equal(decide({ ...base, category: 'supplier_inquiry', level: 'L2' }).disclosureRequired, true);
  assert.equal(decide({ category: 'draft', level: 'L1', external: false }).disclosureRequired, false);
});

/**
 * Pins finding OS-POL-01 of the independent review of 2026-10-07: the authorization boundary.
 * Categories that always need a person ask whatever the external flag says, and a category that leaves the company by
 * definition cannot be made internal by the flag. The worker's booleans templateApproved, counterpartyInRegister and
 * recipientKnown are claims, not evidence: an L2 allow needs evidence references (template id and version, From, To)
 * that a PolicyEvidenceVerifier injected by the caller confirms against trusted records. Without a verifier the answer
 * is ask, never allow, and the policy module stays pure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as policy from '../src/policy.js';
import type { PolicyResult, ProposedAction } from '../src/policy.js';
import { createServer } from '../src/server.js';
import { CHECKS, CONFIG, DRAWING, EVIDENCED, SPEC, TRUSTED, VERIFIER, bratislava } from './policy_fixtures.js';

function askedFor(r: PolicyResult, pattern: RegExp): void {
  assert.equal(r.decision, 'ask', `expected ask, got ${r.decision}: ${r.reasons.join('; ')}`);
  assert.ok(r.reasons.some((x) => pattern.test(x)), `no reason matches ${pattern}: ${r.reasons.join('; ')}`);
}

function deniedFor(r: PolicyResult, pattern: RegExp): void {
  assert.equal(r.decision, 'deny', `expected deny, got ${r.decision}: ${r.reasons.join('; ')}`);
  assert.ok(r.reasons.some((x) => pattern.test(x)), `no reason matches ${pattern}: ${r.reasons.join('; ')}`);
}

/** The server's clock reading without any evidence verifier. */
const CLOCK_ONLY = { now: bratislava('10:00') };

test('OS-POL-01: alwaysAsk categories ask whatever the external flag says', () => {
  const r = policy.decide({ category: 'order', level: 'L2', external: false });
  assert.equal(r.decision, 'ask', `the review's reproduction: ${r.decision}: ${r.reasons.join('; ')}`);
  for (const category of CONFIG.alwaysAsk) {
    for (const level of ['L1', 'L2', 'L3'] as const) {
      assert.equal(policy.decide({ ...EVIDENCED, category, level, external: false }, CONFIG, TRUSTED).decision, 'ask', `${category} at ${level}, flagged internal`);
    }
  }
  assert.equal(policy.decide({ category: 'draft', level: 'L1', external: false }, { ...CONFIG, alwaysAsk: [...CONFIG.alwaysAsk, 'draft'] }).decision, 'ask');
  assert.equal(policy.decide({ category: 'draft', level: 'L1', external: false }, CONFIG).decision, 'allow');
});

test('OS-POL-01: a category that leaves the company by definition cannot be made internal by the flag', () => {
  deniedFor(policy.decide({ category: 'drawing_release', level: 'L2', external: false, attachments: [DRAWING] }, CONFIG, TRUSTED), /0 of 3 named checks/);
  for (const category of ['supplier_inquiry', 'supplier_followup', 'customer_quote', 'new_counterparty', 'drawing_release', 'send_external'] as const) {
    deniedFor(policy.decide({ ...EVIDENCED, category, external: false, subject: 'Beta Foundry pattern' }, CONFIG, TRUSTED), /confidential name in subject/);
  }
});

test('OS-POL-01: without a verifier an L2 action asks, never allows, whatever the claims say', () => {
  const priced: ProposedAction = {
    category: 'supplier_inquiry', level: 'L2', external: true, counterpartyInRegister: true, recipientKnown: true, templateApproved: true,
    text: 'We confirm our price EUR 100 and 90-day payment terms.',
  };
  askedFor(policy.decide(priced, CONFIG, CLOCK_ONLY), /no evidence verifier/);
  askedFor(policy.decide(EVIDENCED, CONFIG, CLOCK_ONLY), /no evidence verifier/);
  askedFor(policy.decide({ ...EVIDENCED, category: 'supplier_followup' }, CONFIG, CLOCK_ONLY), /no evidence verifier/);
});

test('OS-POL-01: the L2 allow path requires evidence references, and the claims are neither needed nor sufficient', () => {
  assert.equal(policy.decide(EVIDENCED, CONFIG, TRUSTED).decision, 'allow', 'positive control: verified evidence');
  askedFor(policy.decide({ ...EVIDENCED, templateId: undefined }, CONFIG, TRUSTED), /no templateId and templateVersion/);
  askedFor(policy.decide({ ...EVIDENCED, templateVersion: ' ' }, CONFIG, TRUSTED), /no templateId and templateVersion/);
  askedFor(policy.decide({ ...EVIDENCED, from: undefined }, CONFIG, TRUSTED), /no sending identity/);
  askedFor(policy.decide({ ...EVIDENCED, to: [] }, CONFIG, TRUSTED), /no recipient/);
  const noClaims: ProposedAction = { ...EVIDENCED };
  delete noClaims.counterpartyInRegister;
  delete noClaims.recipientKnown;
  delete noClaims.templateApproved;
  assert.equal(policy.decide(noClaims, CONFIG, TRUSTED).decision, 'allow');
});

test('OS-POL-01: the injected verifier decides each claim against trusted records', () => {
  askedFor(policy.decide({ ...EVIDENCED, templateApproved: true, templateVersion: '4' }, CONFIG, TRUSTED), /template tpl-rfq-supplier version 4 is not an approved revision/);
  askedFor(policy.decide({ ...EVIDENCED, to: [{ address: 'unknown@example.com' }] }, CONFIG, TRUSTED), /recipient unknown@example\.com is not in the register/);
  askedFor(policy.decide({ ...EVIDENCED, cc: [{ address: 'copy@example.com' }] }, CONFIG, TRUSTED), /recipient copy@example\.com is not in the register/);
  askedFor(policy.decide({ ...EVIDENCED, bcc: [{ address: 'hidden@example.com' }] }, CONFIG, TRUSTED), /recipient hidden@example\.com is not in the register/);
  askedFor(policy.decide({ ...EVIDENCED, attachments: [{ ...SPEC, sha256: 'ff'.repeat(32) }] }, CONFIG, TRUSTED), /rfq_scope_rev1\.pdf does not match the document store/);
  deniedFor(policy.decide({ ...EVIDENCED, attachments: [SPEC, DRAWING], drawingChecks: [...CHECKS.slice(0, 2), { ...CHECKS[2], by: 'Somebody Else' }] }, CONFIG, TRUSTED), /has 2 of 3 named checks/);
  deniedFor(policy.decide({ ...EVIDENCED, from: { address: 'm.example@example.com', name: 'M. Example' } }, CONFIG, TRUSTED), /not authorized for workers/);
});

test('OS-POL-01: a false claim still makes the decision stricter', () => {
  askedFor(policy.decide({ ...EVIDENCED, counterpartyInRegister: false }, CONFIG, TRUSTED), /counterparty not in the register/);
  askedFor(policy.decide({ ...EVIDENCED, recipientKnown: false }, CONFIG, TRUSTED), /recipient unknown/);
  askedFor(policy.decide({ ...EVIDENCED, templateApproved: false }, CONFIG, TRUSTED), /template not approved by a person/);
});

test('OS-POL-01: policy_check through the server asks without a verifier and allows with an injected one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'os-authz-'));
  const policyCheck = async (verified: boolean) => {
    const { tools } = await createServer({ stateDir: dir, policy: CONFIG, clock: () => bratislava('10:00'), ...(verified ? { verifier: VERIFIER } : {}) });
    const t = tools.find((x) => x.name === 'policy_check');
    assert.ok(t);
    return (await t.handler({ ...EVIDENCED })) as PolicyResult;
  };
  askedFor(await policyCheck(false), /no evidence verifier/);
  assert.equal((await policyCheck(true)).decision, 'allow');
});

test('OS-POL-01: the policy module stays pure: no imports, no clock reads, no storage', async () => {
  const source = await readFile(path.resolve('src/policy.ts'), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s+(?!type\s)/m, 'no runtime import');
  assert.doesNotMatch(source, /\brequire\s*\(|\bimport\s*\(/, 'no dynamic loading');
  assert.doesNotMatch(source, /Date\.now\s*\(|new Date\s*\(\s*\)|performance\.now/, 'no clock read');
  assert.doesNotMatch(source, /\bprocess\.|\bfetch\s*\(|['"]node:/, 'no process, network or node built-in');
});

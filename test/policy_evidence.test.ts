/**
 * Pins finding OS-POL-03 of the independent review of 2026-10-07: evidence fields on the proposed action.
 * The action carries the actual From, To, Cc and Bcc, an attachment manifest (document id, immutable revision, sha256,
 * filename), drawing checks as named checks with who and when instead of a count, template id and version, an uncertain
 * flag, a named supervisor and disclosureRendered. The confidential-name scan covers subject, body, attachment filenames
 * and display names; an unset denylist, or an empty one without allowEmptyDenylist, is a configuration error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as policy from '../src/policy.js';
import type { AttachmentEvidence, DrawingCheckEvidence, PolicyConfig, PolicyResult, ProposedAction } from '../src/policy.js';
import { createServer } from '../src/server.js';
import { CHECKS, CONFIG, DRAWING, EVIDENCED, SPEC, TRUSTED, bratislava } from './policy_fixtures.js';

function deniedFor(r: PolicyResult, pattern: RegExp): void {
  assert.equal(r.decision, 'deny', `expected deny, got ${r.decision}: ${r.reasons.join('; ')}`);
  assert.ok(r.reasons.some((x) => pattern.test(x)), `no reason matches ${pattern}: ${r.reasons.join('; ')}`);
}

function askedFor(r: PolicyResult, pattern: RegExp): void {
  assert.equal(r.decision, 'ask', `expected ask, got ${r.decision}: ${r.reasons.join('; ')}`);
  assert.ok(r.reasons.some((x) => pattern.test(x)), `no reason matches ${pattern}: ${r.reasons.join('; ')}`);
}

const send = (patch: Partial<ProposedAction>, config: PolicyConfig = CONFIG) => policy.decide({ ...EVIDENCED, ...patch }, config, TRUSTED);

test('OS-POL-03: the confidential-name scan covers subject, body, attachment filenames and display names', () => {
  assert.equal(send({}).decision, 'allow', 'positive control: the evidenced message without names');
  deniedFor(send({ subject: 'Pattern from Beta Foundry' }), /confidential name in subject: Beta Foundry/);
  deniedFor(send({ text: 'Quote based on the Beta Foundry pattern' }), /confidential name in body: Beta Foundry/);
  deniedFor(send({ attachments: [{ ...SPEC, filename: 'beta_foundry_pattern.pdf' }] }), /confidential name in attachment filename: Beta Foundry/);
  deniedFor(send({ to: [{ address: 'offers@example.com', name: 'Beta Foundry sales' }] }), /confidential name in to display name/);
  deniedFor(send({ cc: [{ address: 'cc@example.com', name: 'Partner Alpha Works' }] }), /confidential name in cc display name/);
  deniedFor(send({ bcc: [{ address: 'bcc@example.com', name: 'PARTNER-ALPHA-WORKS' }] }), /confidential name in bcc display name/);
  deniedFor(send({ from: { address: 'rfq-worker@example.com', name: 'Beta Foundry desk' } }), /confidential name in from display name/);
});

test('OS-POL-03: the scan reads names through case, separators and accents', () => {
  const names = ['Beta Foundry'];
  assert.deepEqual(policy.findConfidentialNames('BETA.FOUNDRY rev 3', names), names);
  assert.deepEqual(policy.findConfidentialNames('Béta-Foundry_rev3.pdf', names), names);
  assert.deepEqual(policy.findConfidentialNames('BetaFoundry.pdf', names), names);
  assert.deepEqual(policy.findConfidentialNames('alpha works rev 3', names), []);
});

test('OS-POL-03: an unset denylist is a configuration error; an empty one needs allowEmptyDenylist', () => {
  const unset = { ...CONFIG } as PolicyConfig;
  delete unset.confidentialNames;
  deniedFor(policy.decide(EVIDENCED, unset, TRUSTED), /denylist is not configured/);
  deniedFor(policy.decide(EVIDENCED, { ...CONFIG, confidentialNames: [] }, TRUSTED), /denylist is empty/);
  deniedFor(policy.decide(EVIDENCED, { ...CONFIG, confidentialNames: ['  '] }, TRUSTED), /denylist is empty/);
  assert.equal(policy.decide(EVIDENCED, { ...CONFIG, confidentialNames: [], allowEmptyDenylist: true }, TRUSTED).decision, 'allow');
  // The template default ships the list unset, so an unconfigured instance cannot send anything external.
  assert.equal(policy.DEFAULT_POLICY.confidentialNames, undefined);
  deniedFor(policy.decide(EVIDENCED, policy.DEFAULT_POLICY, TRUSTED), /denylist is not configured/);
  // Internal work does not depend on the denylist.
  assert.equal(policy.decide({ category: 'draft', level: 'L1', external: false }, unset).decision, 'allow');
});

test('OS-POL-03: an uncertain classification always asks, and a deny still wins over it', () => {
  askedFor(send({ uncertain: true }), /uncertain/);
  askedFor(policy.decide({ category: 'draft', level: 'L1', external: false, uncertain: true }, CONFIG), /uncertain/);
  askedFor(policy.decide({ category: 'read', level: 'L0', external: false, uncertain: true }, CONFIG), /uncertain/);
  deniedFor(send({ uncertain: true, subject: 'Beta Foundry' }), /confidential name/);
});

test('OS-POL-03: an autonomous external allow needs the rendered disclosure line and a named supervisor', () => {
  assert.equal(send({}).decision, 'allow', 'positive control');
  askedFor(send({ disclosureRendered: false }), /disclosure line is not rendered/);
  askedFor(send({ disclosureRendered: undefined }), /disclosure line is not rendered/);
  for (const supervisor of [undefined, '', '   ']) askedFor(send({ supervisor }), /no named supervisor/);
});

test('OS-POL-03: drawings need named checks with who and when on the exact revision, not a count', () => {
  const withDrawing = (drawingChecks: DrawingCheckEvidence[], attachments: AttachmentEvidence[] = [SPEC, DRAWING]) => send({ attachments, drawingChecks });
  assert.equal(withDrawing(CHECKS).decision, 'allow', 'positive control: three named checks on revision 3');
  deniedFor(withDrawing([]), /hall_40x18_rev3\.pdf revision 3 has 0 of 3 named checks/);
  deniedFor(withDrawing(CHECKS.slice(0, 2)), /has 2 of 3 named checks/);
  deniedFor(withDrawing([...CHECKS.slice(0, 2), { ...CHECKS[2], revision: '2' }]), /has 2 of 3 named checks/);
  deniedFor(withDrawing([...CHECKS.slice(0, 2), { ...CHECKS[2], by: '  ' }]), /has 2 of 3 named checks/);
  deniedFor(withDrawing([...CHECKS.slice(0, 2), { ...CHECKS[2], at: 'yesterday' }]), /has 2 of 3 named checks/);
  deniedFor(withDrawing([CHECKS[0], CHECKS[1], { ...CHECKS[1], check: 'Graphics Scan', by: 'scan-agent-3' }]), /has 2 of 3 named checks/);
  // A file not declared a document is treated as a drawing; a drawing release must name its drawing.
  deniedFor(withDrawing([], [{ ...SPEC, kind: undefined } as unknown as AttachmentEvidence]), /rfq_scope_rev1\.pdf revision 1 has 0 of 3 named checks/);
  deniedFor(send({ category: 'drawing_release', attachments: [SPEC], drawingChecks: CHECKS }), /drawing_release names no drawing/);
  // A missing or meaningless check requirement is a configuration error, not "no checks needed".
  for (const drawingChecksRequired of [undefined, 0, 2.5]) {
    deniedFor(send({ attachments: [SPEC, DRAWING], drawingChecks: CHECKS }, { ...CONFIG, drawingChecksRequired } as unknown as PolicyConfig), /drawingChecksRequired/);
  }
});

test('OS-POL-03: attachment manifest entries must be complete for an autonomous send', () => {
  for (const [field, value] of [['documentId', ''], ['revision', ' '], ['sha256', 'abc123'], ['filename', '']] as const) {
    const r = send({ attachments: [{ ...SPEC, [field]: value }] });
    askedFor(r, new RegExp(`attachment manifest entry 1 is incomplete: .*${field}`));
  }
});

test('OS-POL-03: policy_check accepts the evidence fields and refuses a bare drawing-check count', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'os-evidence-'));
  const { tools } = await createServer({ stateDir: dir, policy: CONFIG, clock: () => bratislava('10:00') });
  const check = tools.find((t) => t.name === 'policy_check');
  assert.ok(check);
  const input = {
    ...EVIDENCED,
    cc: [{ address: 'cc@example.com', name: 'Copy desk' }],
    bcc: [{ address: 'archive@example.com' }],
    attachments: [SPEC, DRAWING],
    drawingChecks: CHECKS,
    uncertain: false,
  };
  const parsed = check.inputSchema.parse(input) as Record<string, unknown>;
  for (const key of ['from', 'to', 'cc', 'bcc', 'subject', 'text', 'attachments', 'drawingChecks', 'templateId', 'templateVersion', 'uncertain', 'supervisor', 'disclosureRendered'] as const) {
    assert.deepEqual(parsed[key], input[key], key);
  }
  assert.throws(() => check.inputSchema.parse({ ...input, drawingChecks: 3 }));
  deniedFor((await check.handler({ ...input, subject: 'Beta Foundry pattern' })) as PolicyResult, /confidential name in subject/);
});

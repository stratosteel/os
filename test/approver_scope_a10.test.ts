/**
 * Pins A10 of the functional specification and the authenticated-approver part of OS-POL-01 and OS-APP-01 of the
 * independent review of 2026-10-07 (ASTRA: "OS_ROLE/OS_CALLER are startup configuration, not proof of authenticated
 * human approval"; "prove scoped access before real company data, including returned snippets and approval payloads").
 *
 * approval_decide and approval_revoke need a decision token signed with the key of an approver configured on the server
 * (not in the repository): signature, approval id, decision, binding hash, lifetime and scope (tenant, category, job,
 * amount ceiling) are verified, and the decision records the registry's name for the approver, whatever the caller's
 * configured name says. Reads are scoped per actor and job: a colleague without access to a job gets nothing of it in
 * mail results, snippets, files, jobs or approval payloads; an actor without a scope reads nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AccessPolicy } from '../src/access.js';
import type { ApprovalView } from '../src/approvals.js';
import { ApproverRegistry } from '../src/approvers.js';
import { mockProviders } from '../src/mock.js';
import { createServer } from '../src/server.js';
import { TENANT, approverRegistry, decisionToken, makeApprover, tool } from './approver_fixtures.js';
import { CONFIG } from './policy_fixtures.js';

async function stateDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'os-a10-'));
}

async function fileRequest(dir: string, input: Record<string, unknown>, tenant = TENANT): Promise<ApprovalView> {
  const worker = await createServer({ stateDir: dir, role: 'agent', caller: 'worker-1', policy: CONFIG, tenant });
  return (await tool(worker.tools, 'approval_request').handler({ category: 'customer_quote', summary: 'Release quote CN-2026-0101 rev 2', ...input })) as ApprovalView;
}

test('A10: approval_decide needs a token signed by a configured approver; the caller name is not proof; each claim is checked', async () => {
  const dir = await stateDir();
  const a = makeApprover('approver-1', 'M. Example');
  const other = makeApprover('approver-2', 'B. Example');
  const approvers = approverRegistry([{ approver: a }]);
  const human = await createServer({ stateDir: dir, role: 'human', caller: 'Somebody Else', approvers });
  const decide = tool(human.tools, 'approval_decide');
  const req = await fileRequest(dir, { jobId: 'DOP-2026-001', amount: 1_200 });
  const refused = async (input: Record<string, unknown>, pattern: RegExp) => assert.rejects(decide.handler({ id: req.id, decision: 'approved', ...input }), pattern);

  await refused({}, /decision refused: a decision needs a decision token signed by a configured approver; the caller identity is not proof/);
  await refused({ token: { ...decisionToken(other, req.id, 'approved', null), approverId: 'approver-1' } }, /not signed with the key of approver approver-1/);
  await refused({ token: decisionToken(other, req.id, 'approved', null) }, /approver approver-2 is not configured on this server/);
  await refused({ token: decisionToken(a, req.id, 'approved', null, new Date(Date.now() - 20 * 60_000)) }, /expired/);
  await refused({ token: decisionToken(a, req.id, 'approved', null, new Date(), 2 * 3_600_000) }, /lives longer than/);
  await refused({ token: decisionToken(a, 'another-approval', 'approved', null) }, /names approval another-approval/);
  await refused({ token: decisionToken(a, req.id, 'rejected', null) }, /decides rejected, not approved/);
  await refused({ token: decisionToken(a, req.id, 'approved', 'f'.repeat(64)) }, /names binding f+, the request binds none/);
  assert.equal((await human.ctx.approvals.get(req.id))?.status, 'pending', 'nothing was decided by a refused token');

  const token = decisionToken(a, req.id, 'approved', null);
  const decided = (await decide.handler({ id: req.id, decision: 'approved', token, note: 'numbers checked' })) as ApprovalView;
  assert.deepEqual([decided.status, decided.decision?.decidedBy, decided.decision?.approverId], ['approved', 'M. Example', 'approver-1'], 'the registry name, not the configured caller "Somebody Else"');
  await assert.rejects(decide.handler({ id: req.id, decision: 'approved', token }), /already approved/, 'a replayed token decides nothing');

  const unconfigured = await createServer({ stateDir: dir, role: 'human', caller: 'M. Example' });
  await assert.rejects(tool(unconfigured.tools, 'approval_decide').handler({ id: req.id, decision: 'rejected', token: decisionToken(a, req.id, 'rejected', null) }), /no approver registry is configured on this server: a decision cannot be authenticated/);
  assert.throws(() => new ApproverRegistry([{ id: 'x', name: 'X', key: 'c2hvcnQ=', scopes: [{ tenant: TENANT, categories: ['order'] }] }]), /at least 32 bytes/);
});

test('A10: an approver outside its scope is refused with an explicit reason: tenant, category, job, amount ceiling', async () => {
  const dir = await stateDir();
  const a = makeApprover();
  const approvers = approverRegistry([{ approver: a, scopes: [{ tenant: TENANT, categories: ['customer_quote'], jobs: ['DOP-2026-002'], maxAmount: 1_000 }] }]);
  const decide = tool((await createServer({ stateDir: dir, role: 'human', caller: 'M. Example', approvers })).tools, 'approval_decide');
  const attempt = async (req: ApprovalView) => decide.handler({ id: req.id, decision: 'approved', token: decisionToken(a, req.id, 'approved', null) });

  await assert.rejects(attempt(await fileRequest(dir, { jobId: 'DOP-2026-001' })), /job DOP-2026-001 is outside the scope of approver approver-1/);
  await assert.rejects(attempt(await fileRequest(dir, { category: 'order', jobId: 'DOP-2026-002' })), /approver approver-1 may not decide order in tenant tenant-template/);
  await assert.rejects(attempt(await fileRequest(dir, { jobId: 'DOP-2026-002', amount: 1_500 })), /amount 1500 exceeds the ceiling 1000 of approver approver-1/);
  await assert.rejects(attempt(await fileRequest(dir, { jobId: 'DOP-2026-002' }, 'tenant-other')), /approver approver-1 has no scope in tenant tenant-other/);
  const inScope = (await attempt(await fileRequest(dir, { jobId: 'DOP-2026-002', amount: 500 }))) as ApprovalView;
  assert.equal(inScope.status, 'approved', 'positive control: inside every bound');
});

test('A10: approval_revoke needs a signed token too; a revocation is recorded once; agents mount neither deciding tool', async () => {
  const dir = await stateDir();
  const a = makeApprover();
  const outsider = makeApprover('approver-9', 'C. Example');
  const approvers = approverRegistry([{ approver: a }, { approver: outsider, scopes: [{ tenant: TENANT, categories: ['order'] }] }]);
  const human = await createServer({ stateDir: dir, role: 'human', caller: 'M. Example', approvers });
  const req = await fileRequest(dir, { jobId: 'DOP-2026-001' });
  await assert.rejects(tool(human.tools, 'approval_revoke').handler({ id: req.id, token: decisionToken(a, req.id, 'revoked', null) }), /is pending: only an approved request can be revoked/);
  await tool(human.tools, 'approval_decide').handler({ id: req.id, decision: 'approved', token: decisionToken(a, req.id, 'approved', null) });
  await assert.rejects(tool(human.tools, 'approval_revoke').handler({ id: req.id }), /needs a decision token/);
  await assert.rejects(tool(human.tools, 'approval_revoke').handler({ id: req.id, token: decisionToken(outsider, req.id, 'revoked', null) }), /may not decide customer_quote/);
  const revoked = (await tool(human.tools, 'approval_revoke').handler({ id: req.id, note: 'scope changed', token: decisionToken(a, req.id, 'revoked', null) })) as ApprovalView;
  assert.deepEqual([revoked.status, revoked.revocation?.revokedBy, revoked.revocation?.approverId], ['revoked', 'M. Example', 'approver-1']);
  await assert.rejects(tool(human.tools, 'approval_revoke').handler({ id: req.id, token: decisionToken(a, req.id, 'revoked', null) }), /is revoked/);

  const agent = await createServer({ stateDir: dir, role: 'agent', caller: 'worker-1', approvers });
  assert.deepEqual(agent.tools.filter((t) => /approval_(decide|revoke)/.test(t.name)), [], 'an agent client cannot decide or revoke');
});

test('A10: scoped reads: a colleague without access to a job gets nothing of it in mail, snippets, files, jobs or approval payloads', async () => {
  const dir = await stateDir();
  const access: AccessPolicy = { 'worker-1': { jobs: '*' }, 'colleague-1': { jobs: ['DOP-2026-002'] } };
  const worker = await createServer({ stateDir: dir, role: 'agent', caller: 'worker-1', access });
  const colleague = await createServer({ stateDir: dir, role: 'agent', caller: 'colleague-1', access });
  const run = (tools: typeof worker.tools, name: string, input: Record<string, unknown> = {}) => tool(tools, name).handler(input);

  await run(worker.tools, 'approval_request', { category: 'customer_quote', summary: 'Release quote for the hall job', jobId: 'DOP-2026-001', payload: { note: 'restricted-note-hall-job' } });
  await run(worker.tools, 'approval_request', { category: 'customer_quote', summary: 'Release quote for the housing job', jobId: 'DOP-2026-002', payload: { note: 'housing-note' } });

  const mail = (await run(colleague.tools, 'search_mail', { query: '' })) as { id: string }[];
  assert.deepEqual(mail.map((m) => m.id), ['msg-003']);
  assert.equal((await run(colleague.tools, 'get_message', { id: 'msg-001' })), null, 'a message outside the scope does not exist for the colleague');
  assert.equal(((await run(colleague.tools, 'get_message', { id: 'msg-003' })) as { id: string }).id, 'msg-003');
  assert.deepEqual(((await run(colleague.tools, 'search_files', { query: '' })) as { id: string }[]).map((f) => f.id).sort(), ['f-003', 'f-004']);
  assert.equal(await run(colleague.tools, 'get_job', { id: 'DOP-2026-001' }), null);
  assert.deepEqual(((await run(colleague.tools, 'list_jobs')) as { id: string }[]).map((j) => j.id), ['DOP-2026-002']);
  const approvals = (await run(colleague.tools, 'approval_list')) as ApprovalView[];
  assert.deepEqual(approvals.map((v) => v.jobId), ['DOP-2026-002']);
  const everything = JSON.stringify([mail, approvals, await run(colleague.tools, 'search_files', { query: 'rev' }), await run(colleague.tools, 'search_mail', { query: 'hall' })]);
  for (const restricted of ['DOP-2026-001', 'restricted-note-hall-job', 'production hall', 'example-industrial', 'Example Industrial', 'hall_40x18']) {
    assert.ok(!everything.includes(restricted), `nothing of the restricted job leaks: ${restricted}`);
  }
  // Positive control: the actor with the whole tenant sees both jobs.
  assert.equal(((await run(worker.tools, 'approval_list')) as ApprovalView[]).length, 2);
  assert.equal(((await run(worker.tools, 'search_mail', { query: '' })) as unknown[]).length, 3);
});

test('A10: an actor without a scope reads nothing; a worker cannot file for a job outside its scope; real providers get no default scope', async () => {
  const dir = await stateDir();
  const access: AccessPolicy = { 'colleague-1': { jobs: ['DOP-2026-002'] } };
  const stranger = await createServer({ stateDir: dir, role: 'agent', caller: 'stranger', access });
  for (const [name, input] of [['search_mail', { query: '' }], ['get_message', { id: 'msg-001' }], ['search_files', { query: '' }], ['get_job', { id: 'DOP-2026-002' }], ['list_jobs', {}]] as const) {
    await assert.rejects(tool(stranger.tools, name).handler(input), /caller stranger has no access scope on this server: reads are refused/, name);
  }
  assert.deepEqual(await tool(stranger.tools, 'approval_list').handler({}), []);
  const colleague = await createServer({ stateDir: dir, role: 'agent', caller: 'colleague-1', access });
  await assert.rejects(tool(colleague.tools, 'approval_request').handler({ category: 'customer_quote', summary: 'Release the hall quote', jobId: 'DOP-2026-001' }), /caller colleague-1 has no access to job DOP-2026-001/);
  const real = await createServer({ stateDir: dir, role: 'agent', caller: 'worker-1', providers: mockProviders(path.join(dir, 'ledger.md')) });
  await assert.rejects(tool(real.tools, 'search_mail').handler({ query: '' }), /no access policy is configured on this server: reads are refused/);
});

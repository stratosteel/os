import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { parseManifest, gateOrderErrors } from '../src/manifest.js';
import type { ToolDef } from '../src/tools.js';
import { CONFIG, EVIDENCED, bratislava } from './policy_fixtures.js';

function tool(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} missing`);
  return t;
}

test('agent role mounts every tool except approval_decide; human role mounts it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'os-srv-'));
  const agent = await createServer({ stateDir: dir, role: 'agent', caller: 'worker-1' });
  const names = agent.tools.map((t) => t.name);
  assert.deepEqual(names, ['search_mail', 'get_message', 'search_files', 'get_job', 'list_jobs', 'ledger_append', 'ledger_tail', 'state_of_build', 'policy_check', 'approval_request', 'approval_list']);
  const human = await createServer({ stateDir: dir, role: 'human', caller: 'M. Example' });
  assert.ok(human.tools.some((t) => t.name === 'approval_decide'));
});

test('worked flow over mock providers: inquiry mail -> job -> files -> policy -> approval -> human decision -> ledger', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'os-flow-'));
  const w = await createServer({ stateDir: dir, role: 'agent', caller: 'worker-1', policy: CONFIG, clock: () => bratislava('09:15') });
  const mails = (await tool(w.tools, 'search_mail').handler({ query: 'hall EXC2', mailbox: 'rfq@' })) as { jobId?: string }[];
  assert.equal(mails.length, 1);
  const job = (await tool(w.tools, 'get_job').handler({ id: mails[0].jobId })) as { sourcingPlan: { status: string }[]; children: unknown[] };
  assert.equal(job.children.length, 5);
  assert.equal(job.sourcingPlan.filter((p) => p.status === 'open').length, 2);
  const files = (await tool(w.tools, 'search_files').handler({ query: 'rev3', library: 'Quotes' })) as { revision?: string }[];
  assert.equal(files.length, 1);
  assert.equal(files[0].revision, '3');

  const supplier = (await tool(w.tools, 'policy_check').handler({ ...EVIDENCED, localTime: '09:15' })) as { decision: string };
  assert.equal(supplier.decision, 'allow');
  const quote = (await tool(w.tools, 'policy_check').handler({ ...EVIDENCED, category: 'customer_quote', localTime: '09:15' })) as { decision: string; reasons: string[] };
  assert.equal(quote.decision, 'ask');

  const req = (await tool(w.tools, 'approval_request').handler({ category: 'customer_quote', summary: 'Release CN-2026-0101 rev 2 to Example Industrial GmbH', reasons: quote.reasons })) as { id: string };
  const pending = (await tool(w.tools, 'approval_list').handler({ status: 'pending' })) as unknown[];
  assert.equal(pending.length, 1);
  assert.ok(!w.tools.some((t) => t.name === 'approval_decide'), 'a worker must not be able to decide');

  const h = await createServer({ stateDir: dir, role: 'human', caller: 'M. Example' });
  const decided = (await tool(h.tools, 'approval_decide').handler({ id: req.id, decision: 'approved', note: 'numbers checked' })) as { status: string; decision: { decidedBy: string } };
  assert.equal(decided.status, 'approved');
  assert.equal(decided.decision.decidedBy, 'M. Example');

  const line = (await tool(w.tools, 'ledger_append').handler({ when: '2026-10-06 23:58 CEST', to: 'M. Example', task: 'quote CN-2026-0101 rev 2 released after approval', status: 'DONE', evidence: `approval ${req.id}` })) as string;
  assert.ok(line.startsWith('2026-10-06 23:58 CEST | worker-1 | M. Example |'));
  const tail = (await tool(w.tools, 'ledger_tail').handler({ n: 5 })) as string[];
  assert.equal(tail.length, 1);
  const stored = await readFile(path.join(dir, 'ledger.md'), 'utf8');
  assert.ok(stored.includes('released after approval'));
});

test('MCP server registers the same tool names (SDK v2)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'os-mcp-'));
  const { server, tools } = await createServer({ stateDir: dir });
  assert.ok(server, 'server created');
  assert.equal(tools.length, 11);
});

test('manifest validates and the gate order is enforced', async () => {
  const text = await readFile(path.resolve('layers.yaml'), 'utf8');
  const m = parseManifest(text);
  assert.equal(m.schema, 'stratosteel-os/layers/v0.1');
  assert.deepEqual(gateOrderErrors(m), []);
  const broken = parseManifest(text.replace('G3: { name: first worker supplier inquiry with send record (A05, A09, A11), status: open }', 'G3: { name: x, status: passed }'));
  assert.ok(gateOrderErrors(broken).length);
  assert.throws(() => parseManifest(text.replace('provider: mcp', 'provider: rest')));
});

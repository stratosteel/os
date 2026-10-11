import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FabrixClient, FabrixError, FabrixRecordsProvider, toJobRecord } from '../src/providers/fabrix.js';
import { createServer } from '../src/server.js';
import { mockProviders } from '../src/mock.js';

interface Call { url: string; method: string; headers: Record<string, string>; body: string | null }

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>, calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: (init?.body as string) ?? null });
    const key = Object.keys(routes).find(k => u.includes(k));
    const r = key ? routes[key] : { status: 404, body: { error: 'no route' } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const client = (routes: Record<string, { status?: number; body: unknown }>, calls: Call[]) =>
  new FabrixClient({ baseUrl: 'https://fabrix.example.test/', getToken: async () => 'tok-1', fetchImpl: fakeFetch(routes, calls) });

test('requests carry the worker token and an idempotency key on writes', async () => {
  const calls: Call[] = [];
  const c = client({ '/api/v1/actions/invite_supplier': { body: { data: { invite_id: 'V1' } } } }, calls);
  const out = await c.write('invite_supplier', { round_id: 'R', supplier_id: 'S' }, 'key-12345678');
  assert.deepEqual(out, { invite_id: 'V1' });
  assert.equal(calls[0].url, 'https://fabrix.example.test/api/v1/actions/invite_supplier');
  assert.equal(calls[0].headers['Authorization'], 'Bearer tok-1');
  assert.equal(calls[0].headers['Idempotency-Key'], 'key-12345678');
});

test('a write without a key still gets one, so a retry of the same call object is safe', async () => {
  const calls: Call[] = [];
  const c = client({ '/api/v1/actions/schedule_followup': { body: { data: { recorded: true } } } }, calls);
  await c.write('schedule_followup', { invite_id: 'V1' });
  assert.match(calls[0].headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
});

test('a refusal by FABRIX is an error with its message and status', async () => {
  const calls: Call[] = [];
  const c = client({ '/api/v1/actions/issue_document': { status: 422, body: { error: 'Doklad treba najprv dať na schválenie.' } } }, calls);
  await assert.rejects(() => c.write('issue_document', { document_id: 'D' }), (e: unknown) =>
    e instanceof FabrixError && e.status === 422 && /schválenie/.test(e.message));
});

test('a job becomes a generic JobRecord by its code, and no partner name is copied out', () => {
  const rec = toJobRecord({
    job: { id: 'u1', code: 'Z-2026-044', name: 'Hall', status: 'open', partner_name: 'Example GmbH', owner: 'M. Example', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' },
    docs: [
      { id: 'd1', doc_no: 'DOP-2026-0031', type: 'RFQ_IN', status: 'accepted', partner_id: 'c1' },
      { id: 'd2', doc_no: 'RFQ-2026-0007', type: 'RFQ_OUT', status: 'sent', partner_id: 'p9' },
      { id: 'd3', doc_no: 'CN-2026-0112', type: 'QUOTE', status: 'sent', partner_id: 'c1' },
    ],
  });
  assert.equal(rec.id, 'Z-2026-044');
  assert.equal(rec.stage, 'quoting');
  assert.deepEqual(rec.children.map(c => [c.type, c.id]), [['RFQ_OUT', 'RFQ-2026-0007'], ['CN', 'CN-2026-0112']]);
  assert.equal(rec.children[0].counterparty, 'p9');
});

test('the records provider finds a job by its code and returns null for an unknown one', async () => {
  const calls: Call[] = [];
  const detail = { job: { id: 'u1', code: 'Z-2026-044', name: 'Hall', status: 'won', created_at: 'a', updated_at: 'b' }, docs: [] };
  const p = new FabrixRecordsProvider(client({
    '/api/v1/read/list_jobs': { body: { data: [{ id: 'u1', code: 'Z-2026-044' }] } },
    '/api/v1/read/get_job': { body: { data: detail } },
  }, calls));
  assert.equal((await p.getJob('Z-2026-044'))?.stage, 'ordered');
  assert.equal(await p.getJob('Z-2026-999'), null);
});

test('FABRIX tools are mounted only when layer 2 is FABRIX, and never the human-only ones', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'os-fabrix-'));
  const plain = await createServer({ stateDir: dir, role: 'agent', caller: 'w' });
  assert.equal(plain.tools.some(t => t.name.startsWith('fabrix_')), false);

  const calls: Call[] = [];
  const providers = { ...mockProviders(path.join(dir, 'ledger.md')), fabrix: client({ '/api/v1/read/list_open_items': { body: { data: { total: 0, categories: [] } } } }, calls) };
  const wired = await createServer({ stateDir: dir, role: 'agent', caller: 'w', providers });
  const names = wired.tools.map(t => t.name);
  assert.ok(names.includes('fabrix_issue_document'));
  assert.ok(names.includes('fabrix_list_open_items'));
  for (const forbidden of ['fabrix_decide_approval', 'fabrix_approve_counterparty']) assert.equal(names.includes(forbidden), false);
  const open = wired.tools.find(t => t.name === 'fabrix_list_open_items')!;
  assert.deepEqual(await open.handler({}), { total: 0, categories: [] });
});

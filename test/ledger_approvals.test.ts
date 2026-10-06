import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEntry, formatLine, parseLine, readTail, validateEntry } from '../src/ledger.js';
import { ApprovalQueue } from '../src/approvals.js';

const entry = { when: '2026-10-06 23:55 CEST', from: 'ATLAS', to: 'ASTRA', task: 'test line', status: 'DONE' as const, evidence: 'commit abc1234' };

test('ledger line format and round trip', () => {
  const line = formatLine(entry);
  assert.equal(line, '2026-10-06 23:55 CEST | ATLAS | ASTRA | test line | DONE | commit abc1234');
  assert.deepEqual(parseLine(line), entry);
});

test('ledger validation: time format, empty evidence, separator, dash, status', () => {
  assert.deepEqual(validateEntry(entry), []);
  assert.ok(validateEntry({ ...entry, when: '6.10.2026 23:55' }).length);
  assert.ok(validateEntry({ ...entry, evidence: '' }).some((e) => e.includes('evidence')));
  assert.ok(validateEntry({ ...entry, task: 'a | b' }).some((e) => e.includes('separator')));
  assert.ok(validateEntry({ ...entry, task: 'typographic \u2014 dash' }).some((e) => e.includes('dash')));
  assert.ok(validateEntry({ ...entry, status: 'MAYBE' as never }).some((e) => e.includes('status')));
  assert.throws(() => formatLine({ ...entry, evidence: '' }));
});

test('ledger append is append-only and readable as a tail', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'os-ledger-'));
  const file = path.join(dir, 'ledger.md');
  await appendEntry(file, entry);
  await appendEntry(file, { ...entry, when: '2026-10-06 23:56 CEST', task: 'second' });
  const text = await readFile(file, 'utf8');
  assert.equal(text.split('\n').filter(Boolean).length, 2);
  const tail = await readTail(file, 1);
  assert.equal(tail.length, 1);
  assert.equal(tail[0].task, 'second');
});

test('approval queue: request, list, decide once, second decision rejected, rebuilt from events', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'os-approvals-'));
  const file = path.join(dir, 'approvals.jsonl');
  const q = new ApprovalQueue(file);
  const r = await q.request({ requestedBy: 'worker-1', category: 'customer_quote', summary: 'Release quote CN-2026-0101 rev 2', payload: { jobId: 'DOP-2026-001' }, reasons: ['customer_quote always needs a person'] });
  assert.equal((await q.list('pending')).length, 1);
  const d = await q.decide(r.id, 'approved', 'M. Example', 'ok');
  assert.equal(d.status, 'approved');
  assert.equal((await q.list('pending')).length, 0);
  assert.equal((await q.list('approved')).length, 1);
  await assert.rejects(q.decide(r.id, 'rejected', 'M. Example'), /already approved/);
  await assert.rejects(q.decide('nope', 'approved', 'M. Example'), /unknown approval/);
  await assert.rejects(q.decide(r.id, 'approved', ''), /name a person/);
  const q2 = new ApprovalQueue(file);
  const view = (await q2.list()).find((v) => v.id === r.id);
  assert.equal(view?.status, 'approved');
  assert.equal(view?.decision?.decidedBy, 'M. Example');
});

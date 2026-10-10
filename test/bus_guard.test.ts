/**
 * The bus's pure parts (src/bus/messages.ts, state.ts, guard.ts): the immutable message format, the state file's schema
 * and revision fence, and the loop guard's decisions, which port the XS Lab loop guard (xs-lab tools/loop_guard.py: the turn check, the
 * owner-wait and owner-stop checks, the budget gate, the daily cap and the cooldown (the XS tests
 * tests/test_loop_pacing.py and tests/test_loop_lifecycle.py pin the same decisions in Python). Two deliberate
 * tightenings are pinned too: an owner STOP holds while it is the latest owner message, and an empty bus or an owner
 * message lets only the named role start.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetOf, checkTurn, cooldownActive, ownerStopped, pauseReason, renderStatus, waitingForOwner, withRolledDay } from '../src/bus/guard.js';
import {
  WAITING_MARKER, compareMessages, messageErrors, messageFileName, nextSeq, nextStampMs, parseFileName, parseMessage, serializeMessage,
  type BusMessage, type MessageFields,
} from '../src/bus/messages.js';
import { BUS_STATE_SCHEMA, StateError, parseState, revised, serializeState, type LoopState } from '../src/bus/state.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');

function state(patch: Partial<LoopState> = {}): LoopState {
  return {
    schema: BUS_STATE_SCHEMA, revision: 'rev-1', parent_revision: null, namespace: 'bus', pair: 'role-a_role-b',
    roles: ['role-a', 'role-b'], owner: 'owner', loop_on: true, stop_flag: false, max_rounds_per_day: 15, cooldown_seconds: 5400,
    dispatch_lease_seconds: 300, max_dispatch_attempts: 3, rounds: { date: '2026-10-10', 'role-a': 0, 'role-b': 0 }, whose_turn: 'role-a',
    budget_usd: { approved: 10, spent_estimate: 0, pause_at_ratio: 0.8 }, last_attempt: {}, last_run: {}, dispatch: null,
    ...patch,
  };
}

function fields(author: string, patch: Partial<MessageFields> = {}): MessageFields {
  const owner = author === 'owner';
  return {
    author, status: 'DONE', inReplyTo: 'none', task: 'T-1', done: owner ? 'none' : 'handover', evidence: owner ? 'owner message' : 'run k-1',
    open: 'none', nextOwner: 'none', nextDate: 'none', runKey: owner ? 'none' : 'k-1', body: '', ...patch,
  };
}

let clock = Date.parse('2026-10-10T11:00:00.000Z');
function msg(author: string, patch: Partial<MessageFields> = {}, seen: BusMessage[] = []): BusMessage {
  clock += 1000;
  const stamp = nextStampMs(clock, seen);
  const file = messageFileName(author, stamp, nextSeq(author, seen));
  return parseMessage(file, serializeMessage(fields(author, patch), new Date(stamp).toISOString()))!;
}

test('bus messages: one file per message, named by a causal millisecond stamp; the header carries the handover', () => {
  const f = fields('role-a', { task: 'docs/example.md', done: 'draft reviewed', evidence: 'commit 0000001', open: 'one question', nextOwner: 'role-b', nextDate: '2026-10-11', body: 'short note' });
  const text = serializeMessage(f, '2026-10-10T11:00:00.123Z');
  assert.equal(text, [
    'AUTHOR: role-a', 'STATUS: DONE', 'IN_REPLY_TO: none', 'TASK: docs/example.md', 'DONE: draft reviewed', 'EVIDENCE: commit 0000001',
    'OPEN: one question', 'NEXT_OWNER: role-b', 'NEXT_DATE: 2026-10-11', 'TIMESTAMP_UTC: 2026-10-10T11:00:00.123Z', 'RUN_KEY: k-1', '', 'short note', '',
  ].join('\n'));
  const file = messageFileName('role-a', Date.parse('2026-10-10T11:00:00.123Z'), 7);
  assert.equal(file, '20261010T110000123Z_role-a_007.md');
  const parsed = parseMessage(file, text)!;
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual({ ...parsed, file: undefined, timestampUtc: undefined, tsMs: undefined, seq: undefined, problems: undefined }, { ...f, file: undefined, timestampUtc: undefined, tsMs: undefined, seq: undefined, problems: undefined });

  // Two turns in the same second (even the same millisecond) still sort in the order they were written.
  const first = msg('role-b');
  const second = parseMessage(messageFileName('role-a', nextStampMs(first.tsMs - 500, [first]), 1), serializeMessage(fields('role-a'), 'x'))!;
  assert.ok(second.tsMs > first.tsMs, 'a clock behind the last message is moved past it');
  assert.deepEqual([second, first].sort(compareMessages).map((m) => m.author), ['role-b', 'role-a']);
  assert.deepEqual(parseFileName('20261010T110000Z_role-a_001.md'), { tsMs: Date.parse('2026-10-10T11:00:00Z'), author: 'role-a', seq: 1 }, 'whole-second names (XS) are read');
  assert.equal(parseFileName('20261010T110000Z_role_a_001.md'), null, 'a role id never contains the separator');
  assert.equal(parseFileName('.gitkeep'), null);

  const forged = parseMessage(file, text.replace('AUTHOR: role-a', 'AUTHOR: role-b').replace('STATUS: DONE', 'STATUS: MAYBE').replace('EVIDENCE: commit 0000001\n', ''))!;
  assert.deepEqual(forged.problems, ['header EVIDENCE missing', 'header AUTHOR role-b differs from the file name author role-a', 'STATUS MAYBE is not one of DONE, NOTE, PROBLEM, ACTION_REQUIRED, STOP']);
});

test('bus messages: pointers, not content; a role never writes STOP; replies point at real messages', () => {
  const rules = { roles: ['role-a', 'role-b'], owner: 'owner', existing: new Set(['20261010T110000123Z_role-a_001.md']) };
  assert.deepEqual(messageErrors(fields('role-a'), rules), []);
  assert.deepEqual(messageErrors(fields('owner', { status: 'STOP' }), rules), []);
  const errs = (patch: Partial<MessageFields>, author = 'role-a') => messageErrors(fields(author, patch), rules).join(' | ');
  assert.match(errs({ status: 'STOP' }), /only the owner writes a STOP message/);
  assert.match(errs({ evidence: 'none' }), /EVIDENCE of a role message is never none/);
  assert.match(errs({ task: '' }), /TASK is empty/);
  assert.match(errs({ done: 'line one\nline two' }), /DONE contains a line break/);
  assert.match(errs({ body: 'a typographic \u2013 dash' }), /typographic dash/);
  assert.match(errs({ inReplyTo: '20261010T110000123Z_role-b_009.md' }), /is not a message on this bus/);
  assert.match(errs({ nextOwner: 'someone' }), /NEXT_OWNER someone is not a role or the owner/);
  assert.match(errs({ nextDate: '11.10.2026' }), /NEXT_DATE must be YYYY-MM-DD or none/);
  assert.match(errs({ runKey: 'none' }), /RUN_KEY must be the run key of the attempt/);
  assert.match(errs({ runKey: 'k-1' }, 'owner'), /the owner writes outside attempts/);
  assert.match(errs({ body: 'x'.repeat(4097) }), /body is longer than 4096 bytes: the bus carries metadata and pointers only/);
  assert.match(errs({ evidence: 'e'.repeat(501) }), /longer than 500 characters/);
  assert.match(errs({}, 'intruder'), /author intruder is neither a role/);
});

test('bus state: a foreign loop state is never adopted; an invalid state is an explicit error; every write passes the revision fence', () => {
  const xsShaped = JSON.stringify({ loop_on: true, stop_flag: false, max_rounds_per_day: 15, rounds: { date: '2026-10-10' }, budget_usd: { approved: 250, spent_estimate: 1 } });
  assert.throws(() => parseState(xsShaped), (e: unknown) => e instanceof StateError && /a foreign loop state \(for example an XS state\/loop.json\) is never adopted/.test(e.message));
  assert.throws(() => parseState('{not json'), /bus state is not valid JSON/);
  assert.throws(() => parseState(serializeState(state({ owner: 'role-a' }))), /the two roles and the owner must be distinct/);
  assert.throws(() => parseState(serializeState({ ...state(), roles: ['role-a'] } as unknown as LoopState)), /bus state invalid: roles/);
  const s = state();
  assert.deepEqual(parseState(serializeState(s)), s);
  const text = serializeState(s);
  assert.ok(text.indexOf('"active_turn"') === -1 && text.indexOf('"budget_usd"') < text.indexOf('"cooldown_seconds"'), 'keys are written sorted');
  const next = revised(s, 'rev-2');
  assert.deepEqual([next.revision, next.parent_revision, s.revision], ['rev-2', 'rev-1', 'rev-1'], 'a copy with a fresh revision; the original is untouched');
  const lineA = serializeState(revised(s, 'writer-a')).split('\n').find((l) => l.includes('"revision"'));
  const lineB = serializeState(revised(s, 'writer-b')).split('\n').find((l) => l.includes('"revision"'));
  assert.notEqual(lineA, lineB, 'two writers from the same state always change the same line differently: git cannot merge them silently');
});

test('bus guard: the check order of XS: open attempt, budget, loop, stop, owner, daily cap, cooldown, last author', () => {
  const run = (s: LoopState, messages: BusMessage[] = [], role = 'role-a', now = NOW) => checkTurn(s, messages, role, now);
  assert.deepEqual(run(state()), { run: true, reason: 'turn for role-a; last message none' });

  const attempt = { role: 'role-b', run_key: 'k-9', started_at: '2026-10-10T11:59:00.000Z', count_date: '2026-10-10', outcome: 'reserved', previous_message: null, event: null };
  assert.match(run(state({ active_turn: attempt, budget_usd: null })).reason, /^unfinalized role attempt by role-b \(run key k-9\)/, 'an open attempt blocks both roles, before anything else');

  for (const budget of [null, {}, { approved: 0, spent_estimate: 0 }, { approved: 10, spent_estimate: Number.NaN }, { approved: 10, spent_estimate: -1 }, { approved: '10', spent_estimate: 0 }, { approved: 10, spent_estimate: true }, { approved: 10, spent_estimate: 0, pause_at_ratio: 1.5 }, { approved: 10, spent_estimate: 0, pause_at_ratio: 0 }]) {
    assert.deepEqual(run(state({ budget_usd: budget })), { run: false, reason: 'budget state invalid; no turn' }, JSON.stringify(budget));
  }
  assert.match(run(state({ budget_usd: { approved: 10, spent_estimate: 8 } })).reason, /^budget conservation threshold reached \(spent 8 of approved 10, pause at 0.8\)/);
  assert.equal(run(state({ budget_usd: { approved: 10, spent_estimate: 7.99 } })).run, true);
  assert.equal(budgetOf(state({ budget_usd: { approved: 10, spent_estimate: 0 } })).pauseAtRatio, 0.8, 'the XS default ratio');
  assert.deepEqual(run(state({ loop_on: false })), { run: false, reason: 'loop_on is false' });
  assert.deepEqual(run(state({ stop_flag: true })), { run: false, reason: 'stop_flag is set' });

  // Owner STOP: holds while it is the latest owner message, even with a role message after it (XS looked at the last only).
  const m1 = msg('role-b');
  const stopMsg = msg('owner', { status: 'STOP', inReplyTo: m1.file }, [m1]);
  const after = msg('role-b', {}, [m1, stopMsg]);
  assert.equal(ownerStopped(state(), [m1, stopMsg, after]), true);
  assert.deepEqual(run(state(), [m1, stopMsg, after]), { run: false, reason: 'the latest owner message is a STOP' });
  const resume = msg('owner', { status: 'NOTE', nextOwner: 'role-a' }, [m1, stopMsg, after]);
  assert.equal(ownerStopped(state(), [m1, stopMsg, after, resume]), false, 'a later owner message lifts it');
  assert.equal(ownerStopped(state(), [msg('owner', { status: 'NOTE', body: 'please STOP now' })]), true, 'the word STOP in an owner body stops, as XS');

  // Waiting for the owner.
  const ask = msg('role-b', { status: 'ACTION_REQUIRED' });
  assert.equal(waitingForOwner(state(), [ask]), true);
  assert.deepEqual(run(state(), [ask]), { run: false, reason: 'the last message waits for the owner' });
  assert.equal(waitingForOwner(state(), [msg('role-b', { body: `Decision needed. ${WAITING_MARKER}` })]), true);
  const answer = msg('owner', { status: 'NOTE', nextOwner: 'role-a' }, [ask]);
  assert.equal(run(state(), [ask, answer]).run, true, 'an owner answer resumes; its NEXT_OWNER names the role');
  assert.deepEqual(run(state(), [ask, answer], 'role-b'), { run: false, reason: 'the turn belongs to role-a' });

  // Daily cap per UTC day; a new day starts at 0.
  assert.deepEqual(run(state({ rounds: { date: '2026-10-10', 'role-a': 15, 'role-b': 0 } }), [m1]), { run: false, reason: 'daily cap reached for role-a (15 of 15)' });
  assert.equal(run(state({ rounds: { date: '2026-10-09', 'role-a': 15, 'role-b': 15 } }), [m1]).run, true);
  assert.deepEqual(withRolledDay(state({ rounds: { date: '2026-10-09', 'role-a': 3, 'role-b': 2 } }), NOW).rounds, { date: '2026-10-10', 'role-a': 0, 'role-b': 0 });

  // Cooldown: exact boundary; malformed or future completion times keep it active.
  const lastRun = (v: unknown) => state({ last_run: { 'role-a': v } });
  assert.equal(cooldownActive(lastRun('2026-10-10T10:30:00.001Z'), 'role-a', NOW), true, '5400 s minus 1 ms');
  assert.equal(cooldownActive(lastRun('2026-10-10T10:30:00.000Z'), 'role-a', NOW), false, 'exactly 5400 s');
  for (const v of ['bad', 7, '2026-10-11T00:00:00Z', '']) assert.equal(cooldownActive(lastRun(v), 'role-a', NOW), true, String(v));
  assert.match(run(lastRun('2026-10-10T11:00:00Z'), [m1]).reason, /^cooldown active for role-a \(5400 s after its last completion\)/);
  assert.equal(cooldownActive(state({ cooldown_seconds: 0, last_run: { 'role-a': '2026-10-10T11:59:59Z' } }), 'role-a', NOW), false);

  // The last author does not answer itself; an empty bus starts with whose_turn; the owner never takes turns.
  assert.deepEqual(run(state(), [msg('role-a')]), { run: false, reason: 'last message is by role-a and nobody answered yet; nothing to do' });
  assert.deepEqual(run(state({ whose_turn: 'role-b' })), { run: false, reason: 'the turn belongs to role-b' });
  assert.match(run(state(), [], 'owner').reason, /owner is not a role of this bus/);
});

test('bus guard: the pause conditions stop dispatch as well; the STATUS view is a pure function of the state and the messages', () => {
  assert.equal(pauseReason(state(), []), null);
  assert.match(String(pauseReason(state({ budget_usd: { approved: 10, spent_estimate: 9 } }), [])), /budget conservation threshold/);
  const m1 = msg('role-a');
  const m2 = msg('role-b', { status: 'ACTION_REQUIRED', inReplyTo: m1.file }, [m1]);
  const s = state({ whose_turn: 'role-a', rounds: { date: '2026-10-10', 'role-a': 1, 'role-b': 1 } });
  const view = renderStatus(s, [m1, m2]);
  assert.equal(renderStatus(structuredClone(s), [m1, m2]), view, 'same inputs, same bytes');
  assert.notEqual(renderStatus(revised(s, 'rev-2'), [m1, m2]), view, 'the revision is part of the view');
  assert.match(view, /^# BUS STATUS: role-a_role-b\n/);
  assert.match(view, /state revision rev-1 and 2 messages/);
  assert.match(view, /rounds 2026-10-10: role-a 1, role-b 1/);
  assert.match(view, /pause: the last message waits for the owner/);
  assert.match(view, /\*\*WAITING FOR THE OWNER\*\*/);
  assert.match(view, new RegExp(`- \`${m2.file}\` · ACTION_REQUIRED · task T-1`));
  assert.doesNotMatch(view, /Rebuilt \d{4}-/, 'no wall-clock time in the view');
  assert.match(renderStatus(state({ budget_usd: 'x' }), []), /budget: INVALID \(no turn\)/);
});

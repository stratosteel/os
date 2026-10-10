/**
 * The bus activation gate (ASTRA's first gate, ledger 2026-10-06 20:35 CEST "Ask 2, reuse choice", adopted by ATLAS at
 * 22:20 CEST as the activation gate before any unattended worker): (a) 2 consecutive automatic handover cycles without a
 * person, (b) restart and cold read, (c) duplicate event handling, (d) STOP, (e) failed persistence.
 *
 * Every role turn and every bus command runs as an independent OS process started from dist/ (the bus CLI, and the
 * role runner of test/fixtures/bus_role_runner.ts), against one local bare remote created with `git init --bare` in a
 * temporary directory; every run clones its own working copy. A fake scheduler (driveChain) stands where GitHub Actions
 * stands in production: it starts one run per dispatch the bus makes. Each case persists its evidence (process trace,
 * dispatch queue as the dispatch counter, message files, state before and after, remote log) and prints the paths.
 *
 * What this does not prove: a local bare remote is not GitHub (no network, no branch protection, no Actions dispatch
 * latency); the production replay against the real knowledge repository on an always-on node is still open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  NS, PAIR, busWorkspace, cli, driveChain, freshClone, git, initBus, installHook, persistBusEvidence, readQueue, remoteHead,
  remoteState, remoteSubjects, runRole, spawnCli, spawnRunner, traceEvent, waitFor, CLI,
} from './bus_fixtures.js';

const stateFileOf = (wc: string) => path.join(wc, NS, 'state', 'loop.json');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const count = (items: string[], pattern: RegExp) => items.filter((s) => pattern.test(s)).length;

test('G4 gate (a): two consecutive automatic handover cycles between two roles, every turn an independent process, no person', async (t) => {
  const ws = await busWorkspace('gate-a');
  await initBus(ws, ['--max-rounds-per-day', '2']);
  const before = await remoteState(ws);

  const runs = await driveChain(ws, { to: 'role-a' });

  const after = await remoteState(ws);
  const queue = await readQueue(ws);
  const reader = await freshClone(ws, 'reader');
  const status = await cli(ws, reader, ['status', '--verify']);
  const messages = status.result.summary.messages as { file: string; author: string; status: string; in_reply_to: string; run_key: string; valid: boolean }[];
  const subjects = await remoteSubjects(ws);
  await persistBusEvidence(t, ws, {
    'state_before.json': before,
    'state_after.json': after,
    'runs.json': runs,
    'summary.json': { runs: runs.map((r) => [r.role, r.run_key, r.outcome, r.reason]), dispatches: queue.length, messages: messages.map((m) => [m.file, m.author, m.in_reply_to]) },
  });

  assert.deepEqual(runs.map((r) => [r.role, r.outcome]), [['role-a', 'turn'], ['role-b', 'turn'], ['role-a', 'turn'], ['role-b', 'turn'], ['role-a', 'skipped']]);
  assert.match(String(runs[4].reason), /daily cap reached for role-a \(2 of 2\)/, 'the fifth run is refused by the guard, which ends the chain');
  assert.equal(messages.length, 4, 'four handover messages');
  assert.deepEqual(messages.map((m) => m.author), ['role-a', 'role-b', 'role-a', 'role-b']);
  assert.deepEqual(messages.map((m) => m.in_reply_to), ['none', messages[0].file, messages[1].file, messages[2].file], 'each message answers the previous one');
  assert.deepEqual(messages.map((m) => m.run_key), ['sched-1:1', 'sched-2:1', 'sched-3:1', 'sched-4:1']);
  assert.ok(messages.every((m) => m.valid && m.status === 'DONE'));
  assert.ok(!messages.some((m) => m.author === 'owner'), 'no owner message: nobody relayed anything');
  assert.deepEqual(queue.map((d) => [d.to, d.event]), [['role-b', messages[0].file], ['role-a', messages[1].file], ['role-b', messages[2].file], ['role-a', messages[3].file]], 'one dispatch per handover, each for the message just written');
  assert.deepEqual([after.rounds['role-a'], after.rounds['role-b']], [2, 2]);
  assert.equal(after.active_turn, undefined);
  assert.deepEqual([after.last_attempt['role-a'].outcome, after.last_attempt['role-b'].outcome], ['success', 'success']);
  assert.deepEqual([after.dispatch.for, after.dispatch.to, after.dispatch.status], [messages[3].file, 'role-a', 'sent']);
  assert.deepEqual([count(subjects, /\] reserve /), count(subjects, /\] message /), count(subjects, /\] finalize /), count(subjects, /\] dispatch .* sent for /)], [4, 4, 4, 4]);
  assert.equal(status.result.status_matches, true, 'STATUS.md is the rebuild of the state and the messages');
});

test('G4 gate (b): a restart and a cold read rebuild the state and the STATUS view from the remote alone', async (t) => {
  const ws = await busWorkspace('gate-b');
  await initBus(ws);
  const before = await remoteState(ws);
  const a1 = await runRole(ws, { role: 'role-a', runKey: 'run-a1:1' });
  assert.equal(a1.outcome, 'turn');
  const [d1] = await readQueue(ws);

  // A role-b run reserves its turn and is killed (SIGKILL) before it writes anything else.
  const b1 = await spawnRunner(ws, { role: 'role-b', runKey: 'run-b1:1', event: d1.event, pauseAfterStart: true });
  await b1.paused;
  process.kill(-b1.child.pid!, 'SIGKILL');
  assert.match(String((await b1.result).outcome), /killed by SIGKILL/);
  await traceEvent(ws, { op: 'harness', action: 'killed role-b run run-b1:1 after its reservation' });
  const afterKill = await remoteState(ws);
  assert.equal(afterKill.active_turn.run_key, 'run-b1:1', 'the reservation is durable on the remote');

  // Restart: new processes in new clones know only the remote, and see the reservation.
  for (const role of ['role-b', 'role-a']) {
    const c = await cli(ws, await freshClone(ws, 'cold'), ['check', '--role', role]);
    assert.equal(c.result.run, false);
    assert.match(c.result.reason, /unfinalized role attempt by role-b \(run key run-b1:1\)/);
  }
  // The runtime's finalizer reruns handoff with the dead run's key, from yet another fresh clone.
  const fin = await cli(ws, await freshClone(ws, 'finalizer'), ['handoff', '--role', 'role-b', '--run-key', 'run-b1:1', '--outcome', 'killed'], { dispatch: true });
  assert.equal(fin.code, 0, JSON.stringify(fin.result));
  assert.deepEqual([fin.result.finalized, fin.result.outcome, fin.result.dispatched, fin.result.to], [true, 'killed', true, 'role-a']);

  // Cold read from a third clone: the committed STATUS.md equals the rebuild from the state and the messages.
  const reader = await freshClone(ws, 'reader');
  const st = await cli(ws, reader, ['status', '--verify']);
  assert.equal(st.code, 0, st.result.reason);
  assert.equal(st.result.status_matches, true);
  const s = st.result.summary;
  assert.equal(s.active_turn, null);
  assert.deepEqual([s.last_attempt['role-b'].outcome, s.last_attempt['role-b'].role_message_preserved], ['killed', false]);
  assert.deepEqual(s.messages.map((m: { author: string; status: string; run_key: string }) => [m.author, m.status, m.run_key]), [['role-a', 'DONE', 'run-a1:1'], ['role-b', 'PROBLEM', 'run-b1:1']], 'the killed attempt leaves a PROBLEM record, not a silent gap');
  assert.equal(s.messages[1].in_reply_to, d1.event);
  assert.equal(s.rounds['role-b'], 1, 'the killed attempt counts against the daily cap');
  assert.deepEqual([s.dispatch.for, s.dispatch.to, s.dispatch.status], [s.messages[1].file, 'role-a', 'sent']);
  const committed = await readFile(path.join(reader, NS, 'coordination', 'STATUS.md'), 'utf8');
  assert.match(committed, /active attempt: none/);

  // A crash in the middle of a persist (after the local commit, before the push) leaves nothing on the remote, and the
  // same clone recovers by sync on its next command: the remote is the truth.
  const queueBefore = (await readQueue(ws)).length;
  const event = s.dispatch.for as string;
  const crashed = await freshClone(ws, 'crash');
  const marker = path.join(ws.root, 'post-commit-reached');
  await installHook(path.join(crashed, '.git'), 'post-commit', `touch '${marker}'; sleep 30`);
  const headBefore = await remoteHead(ws);
  const child = spawnCli(ws, crashed, ['start', '--role', 'role-a', '--run-key', 'run-a2:1', '--event', event]);
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await waitFor('the reservation commit', async () => existsSync(marker));
  process.kill(-child.pid!, 'SIGKILL');
  await exited;
  await traceEvent(ws, { op: 'harness', action: 'killed start run-a2:1 between its commit and its push' });
  assert.equal(await remoteHead(ws), headBefore, 'nothing of the killed reservation reached the remote');
  assert.equal((await remoteState(ws)).active_turn, undefined);
  assert.notEqual((await git(ws, ['rev-parse', 'HEAD'], crashed)).trim(), headBefore, 'the crashed clone holds an unpushed commit');
  await rm(path.join(crashed, '.git', 'hooks', 'post-commit'));
  const retry = await cli(ws, crashed, ['start', '--role', 'role-a', '--run-key', 'run-a2:1', '--event', event]);
  assert.equal(retry.code, 0, JSON.stringify(retry.result));
  assert.equal((await remoteState(ws)).active_turn.run_key, 'run-a2:1', 'the same attempt reserves once, cleanly, after the crash');
  assert.equal(count(await remoteSubjects(ws), /reserve role-a run-a2:1/), 1);
  assert.equal((await readQueue(ws)).length, queueBefore, 'no dispatch from the crash');

  await persistBusEvidence(t, ws, { 'state_before.json': before, 'state_after_kill.json': afterKill, 'state_after.json': await remoteState(ws), 'status_summary.json': s, 'status_committed.md': committed });
});

test('G4 gate (c): the same handoff or the same dispatch event delivered twice causes one effect', async (t) => {
  const ws = await busWorkspace('gate-c');
  await initBus(ws);
  const before = await remoteState(ws);
  const wc = await freshClone(ws, 'role-a');
  assert.equal((await cli(ws, wc, ['start', '--role', 'role-a', '--run-key', 'run-a1:1'])).code, 0);
  assert.equal((await cli(ws, wc, ['post', '--role', 'role-a', '--run-key', 'run-a1:1', '--status', 'DONE', '--task', 'T-1', '--done', 'first handover', '--evidence', 'run run-a1:1'])).code, 0);

  // c1: the same handoff twice, from two processes in two fresh clones, one after the other.
  const h1 = await cli(ws, await freshClone(ws, 'h1'), ['handoff', '--role', 'role-a', '--run-key', 'run-a1:1', '--outcome', 'success'], { dispatch: true });
  assert.deepEqual([h1.code, h1.result.finalized, h1.result.dispatched], [0, true, true]);
  const headAfterFirst = await remoteHead(ws);
  const h2 = await cli(ws, await freshClone(ws, 'h2'), ['handoff', '--role', 'role-a', '--run-key', 'run-a1:1', '--outcome', 'success'], { dispatch: true });
  assert.deepEqual([h2.code, h2.result.finalized, h2.result.dispatched], [0, false, false]);
  assert.match(h2.result.reason, /already dispatched to role-b for .*; no duplicate dispatch/);
  assert.equal(await remoteHead(ws), headAfterFirst, 'the second handoff changed nothing');
  const [d1] = await readQueue(ws);
  assert.equal((await readQueue(ws)).length, 1);

  // c2: the same dispatch event delivered twice to role-b at the same time: two runner processes whose first commits
  // wait for each other (post-commit barrier), so both read the same state; exactly one reservation wins.
  const barrier = { dir: path.join(ws.root, 'barrier-c2'), count: 2 };
  await mkdir(barrier.dir);
  const both = await Promise.all([
    runRole(ws, { role: 'role-b', runKey: 'run-b1:1', event: d1.event, barrier }),
    runRole(ws, { role: 'role-b', runKey: 'run-b2:1', event: d1.event, barrier }),
  ]);
  const turns = both.filter((r) => r.outcome === 'turn');
  const others = both.filter((r) => r.outcome !== 'turn');
  assert.equal(turns.length, 1, JSON.stringify(both.map((r) => [r.run_key, r.outcome, r.reason])));
  // With the barrier both read the same state, and the loser's reservation meets the revision fence. Should the barrier
  // time out on a slow machine, the loser starts after the winner and the guard refuses it instead: one effect either way.
  if (others[0].outcome === 'refused') {
    assert.match(String(others[0].reason), /reservation not persisted \(rebase\): rebase conflict: the remote changed .*bus\/state\/loop.json/);
  } else {
    assert.equal(others[0].outcome, 'skipped');
    assert.match(String(others[0].reason), /unfinalized role attempt by role-b|last message is by role-b/);
  }

  // c3: the same event delivered once more, late: no effect.
  const late = await runRole(ws, { role: 'role-b', runKey: 'run-b3:1', event: d1.event });
  assert.equal(late.outcome, 'skipped');
  assert.match(String(late.reason), /last message is by role-b and nobody answered yet/);
  const afterC = await remoteState(ws);
  const queueC = await readQueue(ws);
  assert.deepEqual(queueC.map((d) => d.to), ['role-b', 'role-a'], 'one dispatch per handover, none from the duplicates');
  assert.equal(afterC.rounds['role-b'], 1, 'one reservation for role-b');
  const reader = await freshClone(ws, 'reader');
  const msgs = (await cli(ws, reader, ['status'])).result.summary.messages as { author: string; in_reply_to: string; run_key: string }[];
  assert.equal(msgs.filter((m) => m.author === 'role-b' && m.in_reply_to === d1.event).length, 1, 'one reply to the duplicated event');
  assert.equal(msgs.filter((m) => m.author === 'role-b').length, 1);
  assert.ok(!existsSync(path.join(reader, NS, 'state', 'attempts', `${encodeURIComponent(others[0].run_key)}.json`)), 'the losing run left no attempt record');

  // c4: two handoffs with the same run key at the same time (role-a's second turn), both past their commit before either
  // pushes: exactly one finalize, exactly one dispatch; the other fails closed and its rerun changes nothing.
  const wc2 = await freshClone(ws, 'role-a-2');
  assert.equal((await cli(ws, wc2, ['start', '--role', 'role-a', '--run-key', 'run-a2:1', '--event', queueC[1].event])).code, 0);
  assert.equal((await cli(ws, wc2, ['post', '--role', 'role-a', '--run-key', 'run-a2:1', '--status', 'DONE', '--task', 'T-1', '--done', 'second handover', '--evidence', 'run run-a2:1'])).code, 0);
  const barrierDir = path.join(ws.root, 'barrier-c4');
  await mkdir(barrierDir);
  const racers = [await freshClone(ws, 'race-1'), await freshClone(ws, 'race-2')];
  for (const [i, r] of racers.entries()) {
    await installHook(path.join(r, '.git'), 'post-commit', [
      `[ -e '${barrierDir}/${i}' ] && exit 0`,
      `touch '${barrierDir}/${i}'`,
      'i=0',
      `while [ "$(ls '${barrierDir}' | wc -l)" -lt 2 ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done`,
    ].join('\n'));
  }
  const raced = await Promise.all(racers.map((r) => cli(ws, r, ['handoff', '--role', 'role-a', '--run-key', 'run-a2:1', '--outcome', 'success'], { dispatch: true })));
  const winners = raced.filter((r) => r.code === 0 && r.result.finalized === true);
  assert.equal(winners.length, 1, JSON.stringify(raced.map((r) => r.result)));
  assert.equal(winners[0].result.dispatched, true);
  const loser = raced.find((r) => r !== winners[0])!;
  if (loser.code !== 0) {
    assert.match(loser.result.reason, /finalize not persisted \(rebase\): rebase conflict: .*nothing was dispatched; rerun handoff with the same run key/);
  } else {
    // Barrier timed out on a slow machine: the second handoff came after the first and found it finalized.
    assert.deepEqual([loser.result.finalized, loser.result.dispatched], [false, false]);
  }
  const rerun = await cli(ws, racers[raced.indexOf(loser)], ['handoff', '--role', 'role-a', '--run-key', 'run-a2:1', '--outcome', 'success'], { dispatch: true });
  assert.deepEqual([rerun.code, rerun.result.finalized, rerun.result.dispatched], [0, false, false]);
  const subjects = await remoteSubjects(ws);
  assert.equal(count(subjects, /finalize role-a run-a2:1/), 1, 'exactly one finalize commit');
  assert.equal((await readQueue(ws)).length, 3, 'exactly one more dispatch');

  // c5: a run key reserves at most once (the c2 winner's key, finalized long ago).
  const used = turns[0].run_key;
  const reuse = await cli(ws, await freshClone(ws, 'reuse'), ['start', '--role', 'role-b', '--run-key', used]);
  assert.equal(reuse.code, 1);
  assert.equal(reuse.result.reason, `start refused: run key ${used} was already used by an earlier attempt; a run key reserves at most once`);

  await persistBusEvidence(t, ws, { 'state_before.json': before, 'state_after.json': await remoteState(ws), 'races.json': { c2: both, c4: raced.map((r) => r.result), c4_rerun: rerun.result, c4_loser_path: loser.code === 0 ? 'sequential (barrier timed out)' : 'rebase conflict' } });
});

test('G4 gate (d): the STOP flag halts dispatch and is honoured on the next check', async (t) => {
  const ws = await busWorkspace('gate-d');
  await initBus(ws);
  const before = await remoteState(ws);
  const owner = await freshClone(ws, 'owner');

  // d1: the owner stops the loop while role-a works; role-a finishes its message and finalizes, nothing is dispatched.
  const wc = await freshClone(ws, 'role-a');
  assert.equal((await cli(ws, wc, ['start', '--role', 'role-a', '--run-key', 'run-a1:1'])).code, 0);
  const stop = await cli(ws, owner, ['stop', '--reason', 'planned pause']);
  assert.deepEqual([stop.code, stop.result.reason], [0, 'stopped: stop_flag set and an owner STOP message written']);
  assert.equal((await cli(ws, wc, ['post', '--role', 'role-a', '--run-key', 'run-a1:1', '--status', 'DONE', '--task', 'T-1', '--done', 'work finished', '--evidence', 'run run-a1:1'])).code, 0);
  const h = await cli(ws, wc, ['handoff', '--role', 'role-a', '--run-key', 'run-a1:1', '--outcome', 'success'], { dispatch: true });
  assert.deepEqual([h.code, h.result.finalized, h.result.dispatched], [0, true, false]);
  assert.match(h.result.reason, /paused: stop_flag is set; no dispatch/);
  assert.equal((await readQueue(ws)).length, 0);
  for (const role of ['role-a', 'role-b']) {
    const c = await cli(ws, await freshClone(ws, 'check'), ['check', '--role', role]);
    assert.deepEqual([c.result.run, c.result.reason], [false, 'stop_flag is set']);
  }
  const refused = await cli(ws, await freshClone(ws, 'start-b'), ['start', '--role', 'role-b', '--run-key', 'run-b0:1']);
  assert.deepEqual([refused.code, refused.result.reason], [1, 'start refused: stop_flag is set']);
  const again = await cli(ws, await freshClone(ws, 'again'), ['handoff', '--role', 'role-a', '--run-key', 'run-a1:1', '--outcome', 'success'], { dispatch: true });
  assert.match(again.result.reason, /already finalized; paused: stop_flag is set; no dispatch/);
  const stoppedState = await remoteState(ws);
  assert.equal(stoppedState.stop_flag, true);

  // d2: a STOP that lands between a finalize commit and its push: the rebase conflicts, nothing is dispatched and the
  // previous state is restored; the rerun finalizes and still dispatches nothing.
  assert.equal((await cli(ws, owner, ['resume', '--reason', 'continue'])).code, 0);
  const wb = await freshClone(ws, 'role-b');
  assert.equal((await cli(ws, wb, ['start', '--role', 'role-b', '--run-key', 'run-b1:1'])).code, 0);
  assert.equal((await cli(ws, wb, ['post', '--role', 'role-b', '--run-key', 'run-b1:1', '--status', 'DONE', '--task', 'T-1', '--done', 'reply', '--evidence', 'run run-b1:1'])).code, 0);
  await installHook(path.join(wb, '.git'), 'post-commit', `rm -f "$0"; '${process.execPath}' '${CLI}' stop --repo '${owner}' --reason race --trace '${ws.trace}' >/dev/null`);
  const stateBefore = await readFile(stateFileOf(wb), 'utf8');
  const raced = await cli(ws, wb, ['handoff', '--role', 'role-b', '--run-key', 'run-b1:1', '--outcome', 'success'], { dispatch: true });
  assert.equal(raced.code, 1, JSON.stringify(raced.result));
  assert.match(raced.result.reason, /finalize not persisted \(rebase\): rebase conflict: .*nothing was dispatched/);
  assert.equal(await readFile(stateFileOf(wb), 'utf8'), stateBefore, 'the local state is the previous state again');
  const remoteAfterRace = await remoteState(ws);
  assert.deepEqual([remoteAfterRace.stop_flag, remoteAfterRace.active_turn.run_key], [true, 'run-b1:1'], 'the STOP landed; the attempt is still open');
  const rerun = await cli(ws, wb, ['handoff', '--role', 'role-b', '--run-key', 'run-b1:1', '--outcome', 'success'], { dispatch: true });
  assert.deepEqual([rerun.code, rerun.result.finalized, rerun.result.dispatched], [0, true, false]);
  assert.match(rerun.result.reason, /paused: stop_flag is set; no dispatch/);
  assert.equal((await readQueue(ws)).length, 0, 'no dispatch while stopped');

  // d3: an owner STOP message alone (without the flag) stops as well, and holds until a later owner message.
  assert.equal((await cli(ws, owner, ['resume'])).code, 0);
  const ownerStopMsg = await cli(ws, owner, ['post', '--role', 'owner', '--status', 'STOP', '--task', 'loop control', '--done', 'stop by message', '--evidence', 'owner message']);
  assert.equal(ownerStopMsg.code, 0, JSON.stringify(ownerStopMsg.result));
  const c3 = await cli(ws, await freshClone(ws, 'check'), ['check', '--role', 'role-a']);
  assert.deepEqual([c3.result.run, c3.result.reason], [false, 'the latest owner message is a STOP']);
  assert.equal((await remoteState(ws)).stop_flag, false, 'the flag is clear: the message alone stops');
  const note = await cli(ws, owner, ['post', '--role', 'owner', '--status', 'NOTE', '--task', 'loop control', '--done', 'continue', '--evidence', 'owner message', '--next-owner', 'role-a']);
  assert.equal(note.code, 0);
  const c4 = await cli(ws, await freshClone(ws, 'check'), ['check', '--role', 'role-a']);
  assert.equal(c4.result.run, true, c4.result.reason);

  await persistBusEvidence(t, ws, { 'state_before.json': before, 'state_stopped.json': stoppedState, 'state_after_race.json': remoteAfterRace, 'state_after.json': await remoteState(ws) });
});

test('G4 gate (e): failed persistence (read-only remote, missing remote, rebase conflict, commit error) dispatches nothing and restores the previous state', async (t) => {
  const ws = await busWorkspace('gate-e');
  await initBus(ws);
  const w = await freshClone(ws, 'role-a');
  assert.equal((await cli(ws, w, ['start', '--role', 'role-a', '--run-key', 'run-a1:1'])).code, 0);
  assert.equal((await cli(ws, w, ['post', '--role', 'role-a', '--run-key', 'run-a1:1', '--status', 'DONE', '--task', 'T-1', '--done', 'handover', '--evidence', 'run run-a1:1'])).code, 0);
  const handoff = () => cli(ws, w, ['handoff', '--role', 'role-a', '--run-key', 'run-a1:1', '--outcome', 'success'], { dispatch: true });
  const results: Record<string, unknown> = {};

  const restored: Record<string, unknown>[] = [];
  /** After a failed handoff: no dispatch, the working copy back at the remote head with the previous state, nothing left over. */
  async function assertRestored(label: string, expectedState: string, expectedHead: string): Promise<void> {
    const stateAfter = await readFile(stateFileOf(w), 'utf8');
    const headAfter = (await git(ws, ['rev-parse', 'HEAD'], w)).trim();
    const leftover = (await git(ws, ['status', '--porcelain'], w)).trim();
    const dispatches = (await readQueue(ws)).length;
    restored.push({ case: label, state_before_sha256: sha256(expectedState), state_after_sha256: sha256(stateAfter), head_before: expectedHead, head_after: headAfter, leftover_files: leftover, dispatches });
    assert.equal(dispatches, 0, `${label}: nothing dispatched`);
    assert.equal(stateAfter, expectedState, `${label}: the local state is the previous state`);
    assert.equal(headAfter, expectedHead, `${label}: the working copy is back at the previous head`);
    assert.equal(leftover, '', `${label}: no file left over`);
  }

  // e1: read-only remote (a pre-receive hook refuses every push).
  let stateBefore = await readFile(stateFileOf(w), 'utf8');
  const stateBeforeFailures = stateBefore;
  let headBefore = await remoteHead(ws);
  const readOnly = await installHook(ws.remote, 'pre-receive', 'echo "read-only remote: push refused" >&2; exit 1');
  const e1 = await handoff();
  results.e1 = e1.result;
  assert.equal(e1.code, 1);
  assert.match(e1.result.reason, /finalize not persisted \(push\): push to origin main failed after 3 attempts: .*read-only remote: push refused.*nothing was dispatched/);
  await assertRestored('e1', stateBefore, headBefore);
  assert.equal(await remoteHead(ws), headBefore, 'e1: the remote is unchanged');
  await rm(readOnly);

  // e2: missing remote before the command starts.
  await git(ws, ['remote', 'set-url', 'origin', path.join(ws.root, 'missing.git')], w);
  const e2 = await handoff();
  results.e2 = e2.result;
  assert.equal(e2.code, 1);
  assert.match(e2.result.reason, /^sync failed: fetching origin main failed: /);
  await assertRestored('e2', stateBefore, headBefore);
  await git(ws, ['remote', 'set-url', 'origin', ws.remote], w);

  // e3: the remote disappears between the local commit and the push.
  await installHook(path.join(w, '.git'), 'post-commit', `rm -f "$0"; mv '${ws.remote}' '${ws.remote}.away'`);
  const e3 = await handoff();
  results.e3 = e3.result;
  await rename(`${ws.remote}.away`, ws.remote);
  assert.equal(e3.code, 1);
  assert.match(e3.result.reason, /finalize not persisted \(rebase\): pull --rebase from origin main failed: .*nothing was dispatched/);
  await assertRestored('e3', stateBefore, headBefore);
  assert.equal(await remoteHead(ws), headBefore);

  // e4: forced rebase conflict: a competing writer changes the remote state between our commit and our pull --rebase.
  const competitor = await freshClone(ws, 'competitor');
  const editor = `const f='${NS}/state/loop.json';const fs=require('fs');const s=JSON.parse(fs.readFileSync(f,'utf8'));s.parent_revision=s.revision;s.revision='competing-writer';fs.writeFileSync(f,JSON.stringify(s,null,2)+'\\n')`;
  await installHook(path.join(w, '.git'), 'post-commit', [
    'rm -f "$0"',
    'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_AUTHOR_DATE',
    `cd '${competitor}' && git pull -q origin main && '${process.execPath}' -e "${editor}" && git -c user.name=competitor -c user.email=competitor@example.invalid commit -qam 'competing state write' && git push -q origin HEAD:main`,
  ].join('\n'));
  const e4 = await handoff();
  results.e4 = e4.result;
  assert.equal(e4.code, 1);
  assert.match(e4.result.reason, /finalize not persisted \(rebase\): rebase conflict: the remote changed bus\/state\/loop.json since this command read it; nothing was pushed.*nothing was dispatched/);
  await assertRestored('e4', stateBefore, headBefore);
  assert.equal((await remoteState(ws)).revision, 'competing-writer', 'e4: the competing write stands; ours did not overwrite it');

  // e5: commit error (a pre-commit hook refuses the commit).
  await cli(ws, w, ['check', '--role', 'role-b']);
  stateBefore = await readFile(stateFileOf(w), 'utf8');
  headBefore = await remoteHead(ws);
  const refuseCommit = await installHook(path.join(w, '.git'), 'pre-commit', 'echo "commit refused by hook" >&2; exit 1');
  const e5 = await handoff();
  results.e5 = e5.result;
  assert.equal(e5.code, 1);
  assert.match(e5.result.reason, /finalize not persisted \(commit\): commit failed: commit refused by hook.*nothing was dispatched/);
  await assertRestored('e5', stateBefore, headBefore);
  await rm(refuseCommit);

  // Healthy again: the same handoff finalizes once and dispatches once; a repeat dispatches nothing.
  const ok = await handoff();
  assert.deepEqual([ok.code, ok.result.finalized, ok.result.dispatched], [0, true, true]);
  assert.equal((await handoff()).result.dispatched, false);
  assert.equal((await readQueue(ws)).length, 1);
  assert.equal(count(await remoteSubjects(ws), /finalize role-a run-a1:1/), 1, 'one finalize commit after five failed attempts');

  // e6: a reservation against a read-only remote is refused, nothing is reserved, the local state is the previous one.
  const wb = await freshClone(ws, 'role-b');
  await cli(ws, wb, ['check', '--role', 'role-b']);
  const bState = await readFile(stateFileOf(wb), 'utf8');
  const bHead = await remoteHead(ws);
  const ro = await installHook(ws.remote, 'pre-receive', 'echo "read-only remote: push refused" >&2; exit 1');
  const e6 = await cli(ws, wb, ['start', '--role', 'role-b', '--run-key', 'run-b1:1']);
  results.e6 = e6.result;
  await rm(ro);
  assert.equal(e6.code, 1);
  assert.match(e6.result.reason, /reservation not persisted \(push\): .*read-only remote: push refused.*the previous state is restored; do not start work/);
  assert.equal(await readFile(stateFileOf(wb), 'utf8'), bState);
  assert.equal(await remoteHead(ws), bHead);
  assert.equal((await remoteState(ws)).active_turn, undefined);

  // e7: the dispatch happened but its sent record cannot be persisted: reported, and a rerun within the claim's lease
  // does not dispatch a second time.
  assert.equal((await cli(ws, wb, ['start', '--role', 'role-b', '--run-key', 'run-b1:1'])).code, 0);
  assert.equal((await cli(ws, wb, ['post', '--role', 'role-b', '--run-key', 'run-b1:1', '--status', 'DONE', '--task', 'T-1', '--done', 'reply', '--evidence', 'run run-b1:1'])).code, 0);
  const noSent = await installHook(ws.remote, 'pre-receive', [
    'while read old new ref; do',
    '  if git log --format=%s "$old..$new" | grep -q "dispatch .* sent for"; then echo "sent record refused" >&2; exit 1; fi',
    'done',
    'exit 0',
  ].join('\n'));
  const e7 = await cli(ws, wb, ['handoff', '--role', 'role-b', '--run-key', 'run-b1:1', '--outcome', 'success'], { dispatch: true });
  results.e7 = e7.result;
  assert.equal(e7.code, 1);
  assert.equal(e7.result.dispatched, true);
  assert.match(e7.result.reason, /but the sent record was not persisted \(push: .*sent record refused.*the claim holds until its lease ends/);
  assert.equal((await readQueue(ws)).length, 2);
  const e7rerun = await cli(ws, await freshClone(ws, 'rerun'), ['handoff', '--role', 'role-b', '--run-key', 'run-b1:1', '--outcome', 'success'], { dispatch: true });
  results.e7_rerun = e7rerun.result;
  await rm(noSent);
  assert.match(e7rerun.result.reason, /is claimed by another handoff until .*; no duplicate dispatch/);
  assert.equal((await readQueue(ws)).length, 2, 'no second dispatch within the lease');
  assert.equal((await remoteState(ws)).dispatch.status, 'claimed');

  await persistBusEvidence(t, ws, { 'results.json': results, 'restored.json': restored, 'state_before_failures.json': stateBeforeFailures, 'state_after.json': await remoteState(ws) });
});

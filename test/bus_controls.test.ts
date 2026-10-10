/**
 * The bus's controls beyond the five gate points, across the actual runner (bus CLI and role runner processes against a
 * local bare remote), as ASTRA's reuse boundary asks (ledger 2026-10-06 20:35 CEST: "demonstrate effective concurrency,
 * duplicate and budget controls across the actual runner"):
 *  - budget: reported turn costs accumulate; at the pause ratio the handoff dispatches nothing and every check refuses;
 *    an invalid budget fails closed (the fail-closed patch's budget check at handoff included);
 *  - waiting for the owner: a role's question pauses the loop until an owner message answers;
 *  - dispatch failure: recorded, retried by a rerun, bounded;
 *  - at-least-once wake-up, one effect: after a dispatch whose sent record was lost and an expired claim, a second
 *    wake-up happens and the receiving guard absorbs it;
 *  - isolation: the bus writes only inside its namespace, never adopts a foreign loop state, refuses to discard changes
 *    outside its namespace;
 *  - refusals change nothing on the remote; one command at a time per working copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  NS, busWorkspace, cli, exec, freshClone, git, initBus, installHook, persistBusEvidence, readQueue, remoteHead, remoteState,
  runRole, CLI,
} from './bus_fixtures.js';

const post = (role: string, runKey: string, extra: string[] = []) => ['post', '--role', role, '--run-key', runKey, '--status', 'DONE', '--task', 'T-1', '--done', 'handover', '--evidence', `run ${runKey}`, ...extra];

test('bus controls: reported costs reach the pause ratio and the handoff dispatches nothing; an invalid budget fails closed', async (t) => {
  const ws = await busWorkspace('controls-budget');
  await initBus(ws);
  const a1 = await runRole(ws, { role: 'role-a', runKey: 'run-a1:1', costUsd: 4 });
  assert.equal(a1.outcome, 'turn');
  const [d1] = await readQueue(ws);
  const b1 = await runRole(ws, { role: 'role-b', runKey: 'run-b1:1', event: d1.event, costUsd: 4.5 });
  const handoff = b1.steps.find((s) => s.step === 'handoff')!;
  assert.equal(handoff.code, 0);
  assert.deepEqual([handoff.result.finalized, handoff.result.dispatched], [true, false]);
  assert.match(handoff.result.reason, /paused: budget conservation threshold reached \(spent 8.5 of approved 10, pause at 0.8\); no new turn; no dispatch/);
  assert.equal((await readQueue(ws)).length, 1, 'the handoff that crossed the ratio dispatched nothing');
  const s = await remoteState(ws);
  assert.deepEqual([s.budget_usd.spent_estimate, s.last_attempt['role-b'].cost_usd, s.last_attempt['role-b'].cost_status], [8.5, 4.5, 'reported']);
  const c = await cli(ws, await freshClone(ws, 'check'), ['check', '--role', 'role-a']);
  assert.match(c.result.reason, /^budget conservation threshold reached/);

  // An invalid budget (here a string written into the state by hand) stops every turn.
  const editor = await freshClone(ws, 'editor');
  const file = path.join(editor, NS, 'state', 'loop.json');
  const edited = JSON.parse(await readFile(file, 'utf8'));
  edited.budget_usd = { approved: 'ten', spent_estimate: 0 };
  edited.parent_revision = edited.revision;
  edited.revision = 'hand-edit';
  await writeFile(file, `${JSON.stringify(edited, null, 2)}\n`);
  await git(ws, ['-c', 'user.name=editor', '-c', 'user.email=editor@example.invalid', 'commit', '-qam', 'hand edit of the budget'], editor);
  await git(ws, ['push', '-q', 'origin', 'HEAD:main'], editor);
  for (const role of ['role-a', 'role-b']) {
    const r = await cli(ws, await freshClone(ws, 'check'), ['check', '--role', role]);
    assert.deepEqual([r.result.run, r.result.reason], [false, 'budget state invalid; no turn']);
  }
  const start = await cli(ws, await freshClone(ws, 'start'), ['start', '--role', 'role-a', '--run-key', 'run-a2:1']);
  assert.deepEqual([start.code, start.result.reason], [1, 'start refused: budget state invalid; no turn']);
  // An unreported cost is recorded as unknown and adds nothing.
  const ws2 = await busWorkspace('controls-budget-unknown');
  await initBus(ws2);
  await runRole(ws2, { role: 'role-a', runKey: 'run-a1:1' });
  const s2 = await remoteState(ws2);
  assert.deepEqual([s2.budget_usd.spent_estimate, s2.last_attempt['role-a'].cost_usd, s2.last_attempt['role-a'].cost_status], [0, null, 'unknown']);
  await persistBusEvidence(t, ws, { 'state_after.json': await remoteState(ws) });
});

test('bus controls: a role that asks the owner pauses the loop until an owner message answers', async (t) => {
  const ws = await busWorkspace('controls-owner');
  await initBus(ws);
  const wc = await freshClone(ws, 'role-a');
  assert.equal((await cli(ws, wc, ['start', '--role', 'role-a', '--run-key', 'run-a1:1'])).code, 0);
  assert.equal((await cli(ws, wc, ['post', '--role', 'role-a', '--run-key', 'run-a1:1', '--status', 'ACTION_REQUIRED', '--task', 'T-1', '--done', 'two options prepared', '--evidence', 'path docs/options.md', '--open', 'owner chooses an option', '--next-owner', 'owner'])).code, 0);
  const h = await cli(ws, wc, ['handoff', '--role', 'role-a', '--run-key', 'run-a1:1', '--outcome', 'success'], { dispatch: true });
  assert.match(h.result.reason, /finalized; paused: the last message waits for the owner; no dispatch/);
  assert.equal((await readQueue(ws)).length, 0);
  const status = await readFile(path.join(wc, NS, 'coordination', 'STATUS.md'), 'utf8');
  assert.match(status, /\*\*WAITING FOR THE OWNER\*\*/);
  for (const role of ['role-a', 'role-b']) {
    const c = await cli(ws, await freshClone(ws, 'check'), ['check', '--role', role]);
    assert.deepEqual([c.result.run, c.result.reason], [false, 'the last message waits for the owner']);
  }
  const owner = await freshClone(ws, 'owner');
  const answer = await cli(ws, owner, ['post', '--role', 'owner', '--status', 'NOTE', '--task', 'T-1', '--done', 'option 2 chosen', '--evidence', 'owner decision', '--next-owner', 'role-b']);
  assert.equal(answer.code, 0, JSON.stringify(answer.result));
  assert.equal((await cli(ws, await freshClone(ws, 'check'), ['check', '--role', 'role-b'])).result.run, true);
  assert.match((await cli(ws, await freshClone(ws, 'check'), ['check', '--role', 'role-a'])).result.reason, /the turn belongs to role-b/);
  await persistBusEvidence(t, ws, { 'status_waiting.md': status });
});

test('bus controls: a failed dispatch is recorded and retried by a rerun; the number of attempts is bounded', async (t) => {
  const ws = await busWorkspace('controls-dispatch');
  await initBus(ws, ['--max-dispatch-attempts', '2']);
  const wc = await freshClone(ws, 'role-a');
  await cli(ws, wc, ['start', '--role', 'role-a', '--run-key', 'run-a1:1']);
  await cli(ws, wc, post('role-a', 'run-a1:1'));
  const failing = [process.execPath, '-e', 'process.stderr.write("dispatch endpoint unavailable"); process.exit(3)'];
  const f1 = await cli(ws, wc, ['handoff', '--role', 'role-a', '--run-key', 'run-a1:1', '--outcome', 'success'], { dispatch: failing });
  assert.equal(f1.code, 1);
  assert.match(f1.result.reason, /dispatch to role-b for .* failed: dispatcher exited with 3: dispatch endpoint unavailable; the failure is recorded; a rerun of handoff retries \(attempt 1 of 2\)/);
  assert.deepEqual([(await remoteState(ws)).dispatch.status, (await remoteState(ws)).dispatch.attempts], ['failed', 1]);
  const ok = await cli(ws, await freshClone(ws, 'rerun'), ['handoff', '--role', 'role-a', '--run-key', 'run-a1:1', '--outcome', 'success'], { dispatch: true });
  assert.deepEqual([ok.code, ok.result.finalized, ok.result.dispatched], [0, false, true], 'the already finalized attempt dispatches on the rerun');
  assert.deepEqual([(await remoteState(ws)).dispatch.status, (await remoteState(ws)).dispatch.attempts], ['sent', 2]);
  assert.equal((await readQueue(ws)).length, 1);

  // The bound: two failures, then the rerun gives up explicitly and leaves the turn to the scheduled check.
  const ws2 = await busWorkspace('controls-dispatch-bound');
  await initBus(ws2, ['--max-dispatch-attempts', '2']);
  const w2 = await freshClone(ws2, 'role-a');
  await cli(ws2, w2, ['start', '--role', 'role-a', '--run-key', 'run-a1:1']);
  await cli(ws2, w2, post('role-a', 'run-a1:1'));
  const handoff = () => cli(ws2, w2, ['handoff', '--role', 'role-a', '--run-key', 'run-a1:1', '--outcome', 'success'], { dispatch: failing });
  assert.match((await handoff()).result.reason, /attempt 1 of 2/);
  assert.match((await handoff()).result.reason, /attempt 2 of 2/);
  const third = await handoff();
  assert.equal(third.code, 1);
  assert.match(third.result.reason, /dispatch for .* failed 2 times; role-b's scheduled check picks the turn up/);
  assert.equal((await cli(ws2, await freshClone(ws2, 'check'), ['check', '--role', 'role-b'])).result.run, true, 'the turn is still available to role-b');
  await persistBusEvidence(t, ws, { 'state_after.json': await remoteState(ws), 'bound_state_after.json': await remoteState(ws2) });
});

test('bus controls: after a lost sent record and an expired claim, a second wake-up happens and the receiving guard absorbs it', async (t) => {
  const ws = await busWorkspace('controls-wakeup');
  await initBus(ws, ['--dispatch-lease-seconds', '1']);
  const wc = await freshClone(ws, 'role-a');
  await cli(ws, wc, ['start', '--role', 'role-a', '--run-key', 'run-a1:1']);
  await cli(ws, wc, post('role-a', 'run-a1:1'));
  const noSent = await installHook(ws.remote, 'pre-receive', [
    'while read old new ref; do',
    '  if git log --format=%s "$old..$new" | grep -q "dispatch .* sent for"; then echo "sent record refused" >&2; exit 1; fi',
    'done',
  ].join('\n'));
  const h1 = await cli(ws, wc, ['handoff', '--role', 'role-a', '--run-key', 'run-a1:1', '--outcome', 'success'], { dispatch: true });
  await rm(noSent);
  assert.deepEqual([h1.code, h1.result.dispatched], [1, true]);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const h2 = await cli(ws, await freshClone(ws, 'rerun'), ['handoff', '--role', 'role-a', '--run-key', 'run-a1:1', '--outcome', 'success'], { dispatch: true });
  assert.deepEqual([h2.code, h2.result.dispatched], [0, true], 'the claim expired: the rerun takes it over and dispatches again');
  const queue = await readQueue(ws);
  assert.equal(queue.length, 2);
  assert.equal(queue[0].event, queue[1].event, 'two wake-ups for the same message');
  const runs = [];
  for (const [i, d] of queue.entries()) runs.push(await runRole(ws, { role: d.to, runKey: `run-b${i + 1}:1`, event: d.event }));
  assert.deepEqual(runs.map((r) => r.outcome), ['turn', 'skipped'], 'one effect');
  assert.match(String(runs[1].reason), /last message is by role-b/);
  assert.equal((await remoteState(ws)).rounds['role-b'], 1);
  await persistBusEvidence(t, ws, { 'runs.json': runs, 'state_after.json': await remoteState(ws) });
});

test('bus controls: the bus writes only inside its namespace, never adopts a foreign loop state, never discards foreign changes', async (t) => {
  const ws = await busWorkspace('controls-namespace');
  // A foreign loop state (XS-shaped) where a bus namespace would be: the bus refuses it and init refuses the namespace.
  const seed = await freshClone(ws, 'foreign');
  await mkdir(path.join(seed, 'other', 'state'), { recursive: true });
  await writeFile(path.join(seed, 'other', 'state', 'loop.json'), `${JSON.stringify({ loop_on: true, stop_flag: false, rounds: { date: '2026-10-10' }, budget_usd: { approved: 250, spent_estimate: 1 } }, null, 2)}\n`);
  await writeFile(path.join(seed, 'notes.md'), 'a file outside every bus namespace\n');
  await git(ws, ['add', '.'], seed);
  await git(ws, ['-c', 'user.name=seed', '-c', 'user.email=seed@example.invalid', 'commit', '-qm', 'foreign content'], seed);
  await git(ws, ['push', '-q', 'origin', 'HEAD:main'], seed);
  const foreign = await cli(ws, await freshClone(ws, 'probe'), ['check', '--role', 'role-a', '--namespace', 'other']);
  assert.equal(foreign.code, 1);
  assert.match(foreign.result.reason, /not a stratosteel-os\/bus-state\/v0.1 state: a foreign loop state \(for example an XS state\/loop.json\) is never adopted/);
  const initOther = await cli(ws, await freshClone(ws, 'probe'), ['init', '--namespace', 'other', '--roles', 'role-a,role-b', '--owner', 'owner', '--budget-approved', '10']);
  assert.match(initOther.result.reason, /init refused: the namespace already holds a bus state; init never overwrites one/);
  for (const ns of ['.', '../outside', '/abs', '.git', 'bus/../x']) {
    const r = await cli(ws, await freshClone(ws, 'probe'), ['check', '--role', 'role-a', '--namespace', ns]);
    assert.equal(r.code, 1, ns);
    assert.match(r.result.reason, /namespace must be a relative directory/, ns);
  }

  await initBus(ws);
  await runRole(ws, { role: 'role-a', runKey: 'run-a1:1' });
  const touched = (await git(ws, ['--git-dir', ws.remote, 'log', '--format=', '--name-only', '--grep', '^\\[BUS', 'main'])).split('\n').filter(Boolean);
  assert.ok(touched.length > 0 && touched.every((p) => p.startsWith(`${NS}/`)), `every bus commit touches only ${NS}/: ${[...new Set(touched)].join(', ')}`);

  // A change outside the namespace in the working copy: every command refuses and nothing is discarded.
  const wc = await freshClone(ws, 'shared');
  await writeFile(path.join(wc, 'notes.md'), 'someone else\'s unsaved work\n');
  const refused = await cli(ws, wc, ['check', '--role', 'role-b']);
  assert.equal(refused.code, 1);
  assert.match(refused.result.reason, /the working copy has changes outside the bus namespace \(notes.md\); the bus needs a dedicated clone/);
  assert.equal(await readFile(path.join(wc, 'notes.md'), 'utf8'), 'someone else\'s unsaved work\n', 'nothing discarded');
  // A local commit outside the namespace that is not on the remote: refused as well, never reset away.
  await git(ws, ['-c', 'user.name=x', '-c', 'user.email=x@example.invalid', 'commit', '-qam', 'local work'], wc);
  const refusedCommit = await cli(ws, wc, ['check', '--role', 'role-b']);
  assert.match(refusedCommit.result.reason, /is not on the remote and touches files outside the bus namespace \(notes.md\); refusing to discard it/);
  assert.match(await git(ws, ['log', '-1', '--format=%s'], wc), /local work/);
  // Leftovers inside the namespace (a crashed run's file) are discarded: the remote is the truth.
  const wc2 = await freshClone(ws, 'leftover');
  await writeFile(path.join(wc2, NS, 'coordination', 'leftover.tmp'), 'partial write\n');
  assert.equal((await cli(ws, wc2, ['check', '--role', 'role-b'])).code, 0);
  assert.equal((await git(ws, ['status', '--porcelain'], wc2)).trim(), '');
  await persistBusEvidence(t, ws, { 'bus_commit_paths.txt': `${[...new Set(touched)].join('\n')}\n` });
});

test('bus controls: refusals change nothing on the remote; one command at a time per working copy; usage errors exit 2', async (t) => {
  const ws = await busWorkspace('controls-refusals');
  await initBus(ws);
  const wc = await freshClone(ws, 'role-a');
  assert.equal((await cli(ws, wc, ['start', '--role', 'role-a', '--run-key', 'run-a1:1'])).code, 0);
  const head = await remoteHead(ws);
  const probe = async (args: string[], pattern: RegExp) => {
    const r = await cli(ws, await freshClone(ws, 'probe'), args);
    assert.equal(r.code, 1, `${args.join(' ')}: ${JSON.stringify(r.result)}`);
    assert.match(r.result.reason, pattern);
    assert.equal(await remoteHead(ws), head, `${args[0]} changed the remote`);
  };
  await probe(['handoff', '--role', 'role-b', '--run-key', 'run-a1:1', '--outcome', 'success'], /identity mismatch, the active attempt is role-a run-a1:1; no state mutation/);
  await probe(['handoff', '--role', 'role-a', '--run-key', 'run-x:1', '--outcome', 'success'], /identity mismatch/);
  await probe(post('role-b', 'run-b1:1'), /post refused: no active reservation for role-b run-b1:1; a role writes only inside its reserved attempt/);
  await probe(['post', '--role', 'role-a', '--run-key', 'run-a1:1', '--status', 'STOP', '--task', 'T-1', '--done', 'x', '--evidence', 'y'], /only the owner writes a STOP message/);
  await probe(['post', '--role', 'role-a', '--run-key', 'run-a1:1', '--status', 'DONE', '--task', 'T-1', '--done', 'x', '--evidence', 'none'], /EVIDENCE of a role message is never none/);
  await probe(['start', '--role', 'role-b', '--run-key', 'run-b1:1'], /start refused: unfinalized role attempt by role-a/);
  await probe(['handoff', '--role', 'role-a', '--run-key', 'run-a1:1', '--outcome', 'Bad Outcome'], /outcome must be a lower-case word/);
  await probe(['start', '--role', 'role-a', '--run-key', 'bad key'], /the run key must match/);
  await probe(['start', '--role', 'role-a', '--run-key', 'none'], /and is never none/);
  // Finalize, then: a stale event, an unknown run key, init over an existing bus.
  await cli(ws, wc, post('role-a', 'run-a1:1'));
  await cli(ws, wc, ['handoff', '--role', 'role-a', '--run-key', 'run-a1:1', '--outcome', 'success']);
  const head2 = await remoteHead(ws);
  const stale = await cli(ws, await freshClone(ws, 'probe'), ['start', '--role', 'role-b', '--run-key', 'run-b1:1', '--event', '20261010T000000000Z_role-a_001.md']);
  assert.match(stale.result.reason, /start refused: stale event 20261010T000000000Z_role-a_001.md; the bus moved on/);
  const unknown = await cli(ws, await freshClone(ws, 'probe'), ['handoff', '--role', 'role-b', '--run-key', 'run-b9:1', '--outcome', 'success']);
  assert.match(unknown.result.reason, /handoff refused: no durable reservation for role-b run-b9:1; nothing changed/);
  const reinit = await cli(ws, await freshClone(ws, 'probe'), ['init', '--roles', 'role-a,role-b', '--owner', 'owner', '--budget-approved', '10']);
  assert.match(reinit.result.reason, /init refused: the namespace already holds a bus state/);
  const noBudget = await cli(ws, await freshClone(ws, 'probe'), ['init', '--namespace', 'bus2', '--roles', 'role-a,role-b', '--owner', 'owner']);
  assert.match(noBudget.result.reason, /budgetApproved must be a positive number of USD \(an owner number\)/);
  assert.equal(await remoteHead(ws), head2);

  // One command at a time per working copy: a live holder blocks, a dead one is taken over; a crashed git's index.lock is recovered.
  const gitDir = path.join(wc, '.git');
  await writeFile(path.join(gitDir, 'stratosteel-os-bus.lock'), JSON.stringify({ pid: process.pid }));
  const blocked = await cli(ws, wc, ['check', '--role', 'role-b']);
  assert.deepEqual([blocked.code, blocked.result.reason], [1, `sync: another bus command (pid ${process.pid}) is running in this working copy`]);
  await writeFile(path.join(gitDir, 'stratosteel-os-bus.lock'), JSON.stringify({ pid: 2 ** 22 + 7 }));
  await writeFile(path.join(gitDir, 'index.lock'), '');
  const taken = await cli(ws, wc, ['check', '--role', 'role-b']);
  assert.equal(taken.code, 0, JSON.stringify(taken.result));
  assert.equal(taken.result.run, true);

  const usage = await exec(process.execPath, [CLI, 'dance', '--repo', wc], { env: ws.env });
  assert.equal(usage.code, 2);
  assert.match(usage.stdout, /command must be one of init, check, start, post, handoff, stop, resume, status/);
  const unknownFlag = await exec(process.execPath, [CLI, 'check', '--colour', 'red'], { env: ws.env });
  assert.equal(unknownFlag.code, 2);
  await persistBusEvidence(t, ws, { 'state_after.json': await remoteState(ws) });
});

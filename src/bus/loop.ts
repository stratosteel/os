/**
 * Layer 4 machine channel: the bus loop. The semantics of the XS Lab loop guard (private repository xs-lab, tools/loop_guard.py: check, start, handoff,
 * finish, status) with the fail-closed patch ATLAS wrote on 2026-10-06 (no dispatch after a failed persistence, the
 * previous state restored, dispatch idempotent per last bus message, the budget checked at handoff too), ported to
 * TypeScript for an isolated, configurable namespace of any git repository. Metadata only: no company data, no mail
 * content, no sends; the only side effect besides git is the injected dispatcher, which wakes the other role.
 *
 * One turn of a role: check -> start (a durable reservation with the run key, persisted before any work) -> post (the
 * role's immutable handover message, persisted at once) -> handoff (finalize exactly once, then dispatch the other role
 * once). Every command first syncs the working copy to the remote, so every decision is taken on the remote's state.
 *  - Reservation before work: start persists active_turn and the attempt record; if that fails, nothing was reserved
 *    and the caller must not work. Concurrent reservations conflict on the state's revision fence: exactly one wins.
 *  - Finalize exactly once: handoff with the active run key finalizes; the same handoff again finds the attempt finalized
 *    and changes nothing. A run key reserves at most once (its attempt record stays).
 *  - Dispatch once per last bus message: before calling the dispatcher, the handoff persists a claim (target message,
 *    token, time); a second handoff for the same message finds the claim (live, or sent) and does not dispatch. Only after
 *    a dispatch whose sent record could not be persisted, or a claim whose process died, can a later handoff dispatch
 *    again, after the claim's lease; the receiving guard then absorbs the repeated wake-up (one effect).
 *  - Fail closed: a persistence failure restores the previous state (GitPersistence), dispatches nothing and returns
 *    ok false with the reason. Budget invalid or at its pause ratio, loop_on false, stop_flag, an owner STOP and a pending
 *    question to the owner stop new turns and dispatch alike.
 * Not ported: XS reconcile (releasing an orphan reservation needs the runtime's word that the run is dead, e.g. the GitHub
 * Actions run status); here the runtime reruns handoff with the dead run's key, as the XS finalizer step does.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PersistenceError, namespaceErrors, sanitize, type Author, type GitPersistence } from './git.js';
import { checkTurn, pauseReason, renderStatus, roundsOf, withRolledDay, ownerStopped } from './guard.js';
import {
  DEFAULT_MAX_BODY_BYTES, MESSAGE_STATUSES, ROLE_ID, RUN_KEY, compareMessages, isRunKey, listMessages, messageErrors, messageFileName,
  nextSeq, nextStampMs, parseMessage, serializeMessage, type BusMessage, type MessageFields, type MessageStatus,
} from './messages.js';
import { BUS_STATE_SCHEMA, StateError, otherRole, parseState, revised, serializeState, stableJson, type AttemptRecord, type DispatchRecord, type LoopState } from './state.js';

export interface DispatchTarget {
  /** The role to wake. */
  to: string;
  /** The last bus message the wake-up is for. */
  event: string;
  /** Claim token of this dispatch; a receiver may use it as an idempotency key. */
  token: string;
}

/** Wakes the other role (production: `gh workflow run` or an HTTP call; tests: a counter). Throws on failure. */
export type Dispatcher = (target: DispatchTarget) => Promise<void>;

export interface BusLoopOptions {
  /** Root of the working copy. */
  dir: string;
  /** Directory of this bus inside the working copy. */
  namespace: string;
  persistence: GitPersistence;
  dispatch?: Dispatcher;
  now?: () => Date;
  newId?: () => string;
  maxBodyBytes?: number;
  /** Persistence attempts of the owner's stop and resume (default 5): the owner's intent must land. */
  ownerAttempts?: number;
  ownerRetryDelayMs?: number;
}

export interface BusResult {
  ok: boolean;
  op: string;
  reason: string;
  [key: string]: unknown;
}

export interface InitOptions {
  roles: [string, string];
  owner: string;
  /** The approved budget in USD: an owner number, required. */
  budgetApproved: number;
  budgetSpent?: number;
  /** New turns and dispatch pause when spent reaches approved times this ratio (default 0.8, as XS). */
  pauseAtRatio?: number;
  /** Default 15, the XS value; an instance sets its own. */
  maxRoundsPerDay?: number;
  /** Default 5400 s, the XS value; an instance sets its own. */
  cooldownSeconds?: number;
  /** How long a dispatch claim protects against a second dispatch (default 300 s). */
  dispatchLeaseSeconds?: number;
  maxDispatchAttempts?: number;
  pair?: string;
  /** The role that takes the first turn (default the first role). */
  firstTurn?: string;
}

export interface PostInput {
  status: MessageStatus;
  task: string;
  done: string;
  evidence: string;
  open?: string;
  nextOwner?: string;
  nextDate?: string;
  /** File name of the answered message, 'none', or 'auto' for the last message (default). */
  inReplyTo?: string;
  body?: string;
}

export const OUTCOME = /^[a-z][a-z_]{0,31}$/;

class RefusedError extends Error {}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class BusLoop {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly p: GitPersistence;

  constructor(private readonly o: BusLoopOptions) {
    const errors = namespaceErrors(o.namespace);
    if (errors.length) throw new Error(errors.join('; '));
    this.now = o.now ?? (() => new Date());
    this.newId = o.newId ?? randomUUID;
    this.p = o.persistence;
  }

  private get root(): string {
    return path.join(this.o.dir, this.o.namespace);
  }
  private get stateFile(): string {
    return path.join(this.root, 'state', 'loop.json');
  }
  private get attemptsDir(): string {
    return path.join(this.root, 'state', 'attempts');
  }
  private get statusFile(): string {
    return path.join(this.root, 'coordination', 'STATUS.md');
  }
  private busDir(s: LoopState): string {
    return path.join(this.root, 'coordination', s.pair);
  }
  private attemptFile(runKey: string): string {
    return path.join(this.attemptsDir, `${encodeURIComponent(runKey)}.json`);
  }

  private author(role: string): Author {
    return { name: `${role} bus`, email: `${role.toLowerCase()}-bus@users.noreply.github.com` };
  }

  private async run(op: string, work: () => Promise<BusResult>): Promise<BusResult> {
    try {
      return await work();
    } catch (e) {
      if (e instanceof RefusedError || e instanceof StateError) return { ok: false, op, reason: e.message };
      if (e instanceof PersistenceError) return { ok: false, op, reason: `${e.step === 'sync' ? 'sync failed' : `persistence failed at ${e.step}`}: ${e.message}`, step: e.step };
      throw e;
    }
  }

  private async load(): Promise<{ state: LoopState; messages: BusMessage[] }> {
    let text: string;
    try {
      text = await readFile(this.stateFile, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new StateError(`no bus state at ${this.o.namespace}/state/loop.json: run init first`);
      throw e;
    }
    const state = parseState(text);
    if (state.namespace !== this.o.namespace) throw new StateError(`the state belongs to namespace ${state.namespace}, not ${this.o.namespace}`);
    return { state, messages: await listMessages(this.busDir(state)) };
  }

  private async writeState(state: LoopState, messages: readonly BusMessage[]): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    await writeFile(this.stateFile, serializeState(state), 'utf8');
    await this.writeStatus(state, messages);
  }

  private async writeStatus(state: LoopState, messages: readonly BusMessage[]): Promise<void> {
    await mkdir(path.dirname(this.statusFile), { recursive: true });
    await writeFile(this.statusFile, renderStatus(state, messages), 'utf8');
  }

  private async writeAttempt(rec: AttemptRecord): Promise<void> {
    await mkdir(this.attemptsDir, { recursive: true });
    await writeFile(this.attemptFile(rec.run_key), stableJson(rec), 'utf8');
  }

  /** Validate and create one message file exclusively; returns it parsed. */
  private async writeMessage(state: LoopState, messages: readonly BusMessage[], fields: MessageFields): Promise<BusMessage> {
    const errors = messageErrors(fields, { roles: state.roles, owner: state.owner, existing: new Set(messages.map((m) => m.file)), maxBodyBytes: this.o.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES });
    if (errors.length) throw new RefusedError(`message refused: ${errors.join('; ')}`);
    const stamp = nextStampMs(this.now().getTime(), messages);
    const file = messageFileName(fields.author, stamp, nextSeq(fields.author, messages));
    const text = serializeMessage(fields, new Date(stamp).toISOString());
    await mkdir(this.busDir(state), { recursive: true });
    await writeFile(path.join(this.busDir(state), file), text, { encoding: 'utf8', flag: 'wx' });
    return parseMessage(file, text)!;
  }

  // ---- init -------------------------------------------------------------------------------------------------------

  async init(opts: InitOptions): Promise<BusResult> {
    return this.run('init', async () => {
      const errors: string[] = [];
      const [a, b] = opts.roles ?? [];
      for (const r of [a, b, opts.owner]) if (typeof r !== 'string' || !ROLE_ID.test(r)) errors.push(`role id ${String(r)} must match ${ROLE_ID}`);
      if (a === b || a === opts.owner || b === opts.owner) errors.push('the two roles and the owner must be distinct');
      const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
      if (!num(opts.budgetApproved) || opts.budgetApproved <= 0) errors.push('budgetApproved must be a positive number of USD (an owner number)');
      const spent = opts.budgetSpent ?? 0;
      if (!num(spent) || spent < 0) errors.push('budgetSpent must be a number of at least 0');
      const ratio = opts.pauseAtRatio ?? 0.8;
      if (!num(ratio) || ratio <= 0 || ratio > 1) errors.push('pauseAtRatio must be above 0 and at most 1');
      const ints: [string, number][] = [
        ['maxRoundsPerDay', opts.maxRoundsPerDay ?? 15],
        ['cooldownSeconds', opts.cooldownSeconds ?? 5400],
        ['dispatchLeaseSeconds', opts.dispatchLeaseSeconds ?? 300],
        ['maxDispatchAttempts', opts.maxDispatchAttempts ?? 3],
      ];
      for (const [name, v] of ints) if (!Number.isInteger(v) || v < (name === 'dispatchLeaseSeconds' || name === 'maxDispatchAttempts' ? 1 : 0)) errors.push(`${name} must be a whole number`);
      const pair = opts.pair ?? `${a}_${b}`.toLowerCase();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(pair)) errors.push('pair must be letters, digits, dot, underscore or hyphen');
      const first = opts.firstTurn ?? a;
      if (first !== a && first !== b) errors.push('firstTurn must be one of the two roles');
      if (errors.length) throw new RefusedError(`init refused: ${errors.join('; ')}`);

      await this.p.sync();
      if (existsSync(this.stateFile)) throw new RefusedError('init refused: the namespace already holds a bus state; init never overwrites one');
      if (existsSync(this.root) && (await readdir(this.root)).length) throw new RefusedError(`init refused: ${this.o.namespace} is not empty; init uses an unused namespace and never adopts files it did not write`);
      const now = this.now();
      const state: LoopState = {
        schema: BUS_STATE_SCHEMA,
        revision: this.newId(),
        parent_revision: null,
        namespace: this.o.namespace,
        pair,
        roles: [a, b],
        owner: opts.owner,
        loop_on: true,
        stop_flag: false,
        max_rounds_per_day: ints[0][1],
        cooldown_seconds: ints[1][1],
        dispatch_lease_seconds: ints[2][1],
        max_dispatch_attempts: ints[3][1],
        rounds: { date: now.toISOString().slice(0, 10), [a]: 0, [b]: 0 },
        whose_turn: first,
        budget_usd: { approved: opts.budgetApproved, spent_estimate: spent, pause_at_ratio: ratio },
        last_attempt: {},
        last_run: {},
        dispatch: null,
      };
      await mkdir(this.busDir(state), { recursive: true });
      await mkdir(this.attemptsDir, { recursive: true });
      await writeFile(path.join(this.busDir(state), '.gitkeep'), '', 'utf8');
      await writeFile(path.join(this.attemptsDir, '.gitkeep'), '', 'utf8');
      await this.writeState(state, []);
      try {
        const r = await this.p.persist(`[BUS ${pair}] init`, this.author(opts.owner));
        return { ok: true, op: 'init', reason: `bus ${pair} initialised in ${this.o.namespace}`, head: r.head, revision: state.revision };
      } catch (e) {
        if (e instanceof PersistenceError) throw new RefusedError(`init not persisted (${e.step}): ${e.message}; nothing was created on the remote`);
        throw e;
      }
    });
  }

  // ---- check ------------------------------------------------------------------------------------------------------

  async check(role: string): Promise<BusResult> {
    return this.run('check', async () => {
      const head = await this.p.sync();
      const { state, messages } = await this.load();
      const c = checkTurn(state, messages, role, this.now());
      return { ok: true, op: 'check', run: c.run, reason: c.reason, role, last_message: messages.at(-1)?.file ?? null, head };
    });
  }

  // ---- start: the reservation before work -------------------------------------------------------------------------

  async start(role: string, runKey: string, event?: string): Promise<BusResult> {
    return this.run('start', async () => {
      if (!isRunKey(runKey)) throw new RefusedError(`start refused: the run key must match ${RUN_KEY} and is never none`);
      await this.p.sync();
      const { state, messages } = await this.load();
      const now = this.now();
      const c = checkTurn(state, messages, role, now);
      if (!c.run) throw new RefusedError(`start refused: ${c.reason}`);
      if (existsSync(this.attemptFile(runKey)) || Object.values(state.last_attempt).some((r) => r.run_key === runKey)) {
        throw new RefusedError(`start refused: run key ${runKey} was already used by an earlier attempt; a run key reserves at most once`);
      }
      const last = messages.at(-1);
      if (event !== undefined && event !== 'none' && last?.file !== event) {
        throw new RefusedError(`start refused: stale event ${event}; the bus moved on (last message ${last?.file ?? 'none'}); nothing reserved`);
      }
      const s = revised(withRolledDay(state, now), this.newId());
      const rec: AttemptRecord = {
        role,
        run_key: runKey,
        started_at: now.toISOString(),
        count_date: s.rounds.date,
        outcome: 'reserved',
        previous_message: messages.filter((m) => m.author === role).at(-1)?.file ?? null,
        event: event !== undefined && event !== 'none' ? event : null,
      };
      s.active_turn = rec;
      s.rounds = { ...s.rounds, [role]: roundsOf(s, role) + 1 };
      await this.writeAttempt(rec);
      await this.writeState(s, messages);
      try {
        const r = await this.p.persist(`[BUS ${s.pair}] reserve ${role} ${runKey}`, this.author(role));
        return { ok: true, op: 'start', reserved: true, reason: `reserved ${role} ${runKey}`, role, run_key: runKey, rounds: roundsOf(s, role), head: r.head };
      } catch (e) {
        if (e instanceof PersistenceError) {
          throw new RefusedError(`reservation not persisted (${e.step}): ${e.message}; the previous state is restored; do not start work`);
        }
        throw e;
      }
    });
  }

  // ---- post: one immutable message ---------------------------------------------------------------------------------

  async post(role: string, runKey: string | undefined, input: PostInput): Promise<BusResult> {
    return this.run('post', async () => {
      await this.p.sync();
      const { state, messages } = await this.load();
      const isOwner = role === state.owner;
      if (!isOwner && (state.active_turn?.role !== role || state.active_turn?.run_key !== runKey)) {
        throw new RefusedError(`post refused: no active reservation for ${role} ${runKey ?? '(no run key)'}; a role writes only inside its reserved attempt`);
      }
      if (!MESSAGE_STATUSES.includes(input.status)) throw new RefusedError(`post refused: status must be one of ${MESSAGE_STATUSES.join(', ')}`);
      const inReplyTo = input.inReplyTo === undefined || input.inReplyTo === 'auto' ? messages.at(-1)?.file ?? 'none' : input.inReplyTo;
      const msg = await this.writeMessage(state, messages, {
        author: role,
        status: input.status,
        inReplyTo,
        task: input.task,
        done: input.done,
        evidence: input.evidence,
        open: input.open ?? 'none',
        nextOwner: input.nextOwner ?? (isOwner ? 'none' : otherRole(state, role)),
        nextDate: input.nextDate ?? 'none',
        runKey: isOwner ? 'none' : runKey!,
        body: input.body ?? '',
      });
      await this.writeStatus(state, [...messages, msg].sort(compareMessages));
      try {
        const r = await this.p.persist(`[BUS ${state.pair}] message ${msg.file}`, this.author(role));
        return { ok: true, op: 'post', reason: `message ${msg.file} written`, file: msg.file, head: r.head };
      } catch (e) {
        if (e instanceof PersistenceError) throw new RefusedError(`message not persisted (${e.step}): ${e.message}; the previous state is restored`);
        throw e;
      }
    });
  }

  // ---- handoff: finalize once, dispatch once ----------------------------------------------------------------------

  async handoff(role: string, runKey: string, outcome: string, costUsd?: number): Promise<BusResult> {
    return this.run('handoff', async () => {
      if (!isRunKey(runKey)) throw new RefusedError(`handoff refused: the run key must match ${RUN_KEY} and is never none`);
      if (typeof outcome !== 'string' || !OUTCOME.test(outcome)) throw new RefusedError('handoff refused: outcome must be a lower-case word such as success, failure, cancelled or killed');
      await this.p.sync();
      let { state, messages } = await this.load();
      const token = this.newId();
      let finalized = false;
      let finalOutcome: string | undefined;

      if (state.active_turn) {
        const active = state.active_turn;
        if (active.role !== role || active.run_key !== runKey) {
          throw new RefusedError(`handoff refused: identity mismatch, the active attempt is ${active.role} ${active.run_key}; no state mutation`);
        }
        const now = this.now();
        const other = otherRole(state, role);
        const preserved = messages.some((m) => m.author === role && m.runKey === runKey && m.problems.length === 0);
        finalOutcome = !preserved && outcome === 'success' ? 'missing_role_output' : outcome;
        let all = messages;
        if (!preserved) {
          const fallback = await this.writeMessage(state, messages, {
            author: role,
            status: 'PROBLEM',
            inReplyTo: active.event && messages.some((m) => m.file === active.event) ? active.event : messages.at(-1)?.file ?? 'none',
            task: `bus attempt ${runKey}`,
            done: 'nothing recorded: no role message was preserved in this attempt',
            evidence: `attempt ${runKey} of ${role} ended with ${finalOutcome}`,
            open: 'inspect the runner log; the next turn starts within the guard',
            nextOwner: other,
            nextDate: 'none',
            runKey,
            body: 'Infrastructure handoff, not a result. No routine owner action.',
          });
          all = [...messages, fallback].sort(compareMessages);
        }
        const s = revised(state, this.newId());
        const rec: AttemptRecord = { ...active, outcome: finalOutcome, model_outcome: outcome, completed_at: now.toISOString(), recovered: false, role_message_preserved: preserved };
        const reported = typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0;
        rec.cost_usd = reported ? costUsd : null;
        rec.cost_status = reported ? 'reported' : 'unknown';
        const budget = s.budget_usd as { approved?: unknown; spent_estimate?: unknown } | null;
        if (reported && budget && typeof budget.spent_estimate === 'number' && Number.isFinite(budget.spent_estimate)) {
          s.budget_usd = { ...budget, spent_estimate: Math.round((budget.spent_estimate + (costUsd as number)) * 1e6) / 1e6 };
        }
        delete s.active_turn;
        s.last_attempt = { ...s.last_attempt, [role]: rec };
        s.last_run = { ...s.last_run, [role]: rec.completed_at };
        s.whose_turn = other;
        const target = all.at(-1);
        if (this.o.dispatch && target?.author === role && pauseReason(s, all) === null) {
          s.dispatch = { for: target.file, to: other, token, claimed_at: now.toISOString(), status: 'claimed', attempts: 0 };
        }
        await this.writeAttempt(rec);
        await this.writeState(s, all);
        try {
          await this.p.persist(`[BUS ${s.pair}] finalize ${role} ${runKey} ${finalOutcome}`, this.author(role));
        } catch (e) {
          if (e instanceof PersistenceError) {
            throw new RefusedError(`finalize not persisted (${e.step}): ${e.message}; the previous state is restored and nothing was dispatched; rerun handoff with the same run key`);
          }
          throw e;
        }
        finalized = true;
        ({ state, messages } = await this.load());
      } else if (state.last_attempt[role]?.run_key !== runKey) {
        throw new RefusedError(existsSync(this.attemptFile(runKey))
          ? `handoff refused: ${runKey} is not the latest finalized attempt of ${role}; only the latest attempt dispatches; nothing changed`
          : `handoff refused: no durable reservation for ${role} ${runKey}; nothing changed`);
      }

      const base = { op: 'handoff', role, run_key: runKey, finalized, outcome: finalOutcome ?? state.last_attempt[role]?.outcome };
      const paused = pauseReason(state, messages);
      if (paused) return { ok: true, ...base, dispatched: false, reason: `${finalized ? 'finalized' : 'already finalized'}; paused: ${paused}; no dispatch` };
      if (!this.o.dispatch) return { ok: true, ...base, dispatched: false, reason: `${finalized ? 'finalized' : 'already finalized'}; no dispatcher configured; the other role's scheduled check picks the turn up` };
      const target = messages.at(-1);
      if (!target) return { ok: true, ...base, dispatched: false, reason: 'no message to dispatch for' };
      if (target.author !== role) {
        return { ok: true, ...base, dispatched: false, reason: `the bus moved on: the last message ${target.file} is by ${target.author}; no dispatch from this handoff` };
      }
      const to = otherRole(state, role);
      const now = this.now();
      const d = state.dispatch;
      if (d && d.for === target.file && d.token !== token) {
        if (d.status === 'sent') return { ok: true, ...base, dispatched: false, reason: `already dispatched to ${d.to} for ${target.file}; no duplicate dispatch` };
        const leaseEnd = Date.parse(d.claimed_at) + state.dispatch_lease_seconds * 1000;
        if (d.status === 'claimed' && leaseEnd > now.getTime()) {
          return { ok: true, ...base, dispatched: false, reason: `dispatch for ${target.file} is claimed by another handoff until ${new Date(leaseEnd).toISOString()}; no duplicate dispatch` };
        }
        if (d.attempts >= state.max_dispatch_attempts) {
          return { ok: false, ...base, dispatched: false, reason: `dispatch for ${target.file} failed ${d.attempts} times; ${d.to}'s scheduled check picks the turn up` };
        }
      }
      if (!d || d.for !== target.file || d.token !== token) {
        const previous = d && d.for === target.file ? d : undefined;
        const s = revised(state, this.newId());
        s.dispatch = { for: target.file, to, token, claimed_at: now.toISOString(), status: 'claimed', attempts: previous?.attempts ?? 0 };
        await this.writeState(s, messages);
        try {
          await this.p.persist(`[BUS ${s.pair}] claim dispatch ${to} for ${target.file}`, this.author(role));
        } catch (e) {
          if (e instanceof PersistenceError) throw new RefusedError(`dispatch claim not persisted (${e.step}): ${e.message}; the previous state is restored and nothing was dispatched`);
          throw e;
        }
        ({ state, messages } = await this.load());
        const pausedNow = pauseReason(state, messages);
        if (pausedNow) return { ok: true, ...base, dispatched: false, reason: `claimed; paused: ${pausedNow}; no dispatch` };
      }
      if (state.dispatch?.token !== token || state.dispatch.for !== target.file) {
        return { ok: true, ...base, dispatched: false, reason: 'the dispatch claim belongs to another handoff; no duplicate dispatch' };
      }

      const claim: DispatchRecord = state.dispatch;
      try {
        await this.o.dispatch({ to: claim.to, event: claim.for, token });
      } catch (e) {
        const s = revised(state, this.newId());
        s.dispatch = { ...claim, status: 'failed', attempts: claim.attempts + 1, error: sanitize(errorText(e), 200) };
        await this.writeState(s, messages);
        let recorded = 'the failure is recorded';
        try {
          await this.p.persist(`[BUS ${s.pair}] dispatch ${claim.to} failed`, this.author(role));
        } catch (p) {
          recorded = `the failure record was not persisted either (${errorText(p)})`;
        }
        return { ok: false, ...base, dispatched: false, reason: `dispatch to ${claim.to} for ${claim.for} failed: ${sanitize(errorText(e), 200)}; ${recorded}; a rerun of handoff retries (attempt ${claim.attempts + 1} of ${state.max_dispatch_attempts})` };
      }
      const s = revised(state, this.newId());
      s.dispatch = { ...claim, status: 'sent', attempts: claim.attempts + 1, sent_at: this.now().toISOString() };
      await this.writeState(s, messages);
      try {
        const r = await this.p.persist(`[BUS ${s.pair}] dispatch ${claim.to} sent for ${claim.for}`, this.author(role));
        return { ok: true, ...base, dispatched: true, to: claim.to, event: claim.for, reason: `dispatched ${claim.to} for ${claim.for}`, head: r.head };
      } catch (e) {
        if (e instanceof PersistenceError) {
          return {
            ok: false, ...base, dispatched: true, to: claim.to, event: claim.for,
            reason: `dispatched ${claim.to} for ${claim.for}, but the sent record was not persisted (${e.step}: ${e.message}); the claim holds until its lease ends, after which a later handoff may dispatch again and the receiving guard absorbs the repeated wake-up`,
          };
        }
        throw e;
      }
    });
  }

  // ---- owner: stop and resume -------------------------------------------------------------------------------------

  private async ownerControl(op: 'stop' | 'resume', reasonText: string | undefined): Promise<BusResult> {
    return this.run(op, async () => {
      const attempts = this.o.ownerAttempts ?? 5;
      let last = '';
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        await this.p.sync();
        const { state, messages } = await this.load();
        const stopped = state.stop_flag && ownerStopped(state, messages);
        if (op === 'stop' ? stopped : !state.stop_flag && !ownerStopped(state, messages)) {
          return { ok: true, op, reason: op === 'stop' ? 'already stopped' : 'not stopped' };
        }
        const s = revised(state, this.newId());
        s.stop_flag = op === 'stop';
        const msg = await this.writeMessage(state, messages, {
          author: state.owner,
          status: op === 'stop' ? 'STOP' : 'NOTE',
          inReplyTo: messages.at(-1)?.file ?? 'none',
          task: 'loop control',
          done: op === 'stop' ? 'stop requested by the owner' : 'resume requested by the owner',
          evidence: `owner ${op} command`,
          open: 'none',
          nextOwner: 'none',
          nextDate: 'none',
          runKey: 'none',
          body: reasonText ?? '',
        });
        await this.writeState(s, [...messages, msg].sort(compareMessages));
        try {
          const r = await this.p.persist(`[BUS ${s.pair}] owner ${op}`, this.author(state.owner));
          return { ok: true, op, reason: op === 'stop' ? 'stopped: stop_flag set and an owner STOP message written' : 'resumed: stop_flag cleared and an owner message written', file: msg.file, attempts: attempt, head: r.head };
        } catch (e) {
          if (!(e instanceof PersistenceError)) throw e;
          last = `${e.step}: ${e.message}`;
          await pause((this.o.ownerRetryDelayMs ?? 200) * attempt);
        }
      }
      throw new RefusedError(`owner ${op} not persisted after ${attempts} attempts (${last}); the previous state is restored`);
    });
  }

  stop(reasonText?: string): Promise<BusResult> {
    return this.ownerControl('stop', reasonText);
  }

  resume(reasonText?: string): Promise<BusResult> {
    return this.ownerControl('resume', reasonText);
  }

  // ---- status: the cold read --------------------------------------------------------------------------------------

  /** Rebuild the STATUS view from the state and the messages and compare it with the committed STATUS.md. */
  async status(opts: { sync?: boolean; verify?: boolean; write?: boolean } = {}): Promise<BusResult> {
    return this.run('status', async () => {
      const head = opts.sync === false ? undefined : await this.p.sync();
      const { state, messages } = await this.load();
      const rebuilt = renderStatus(state, messages);
      let committed: string | null = null;
      try {
        committed = await readFile(this.statusFile, 'utf8');
      } catch {
        committed = null;
      }
      const matches = committed === rebuilt;
      if (opts.write && !matches) {
        await this.writeStatus(state, messages);
        await this.p.persist(`[BUS ${state.pair}] rebuild STATUS`, this.author(state.owner));
      }
      return {
        ok: opts.verify ? matches : true,
        op: 'status',
        reason: matches ? 'STATUS.md matches the rebuild from the state and the messages' : 'STATUS.md differs from the rebuild from the state and the messages',
        status_matches: matches,
        head,
        summary: {
          namespace: state.namespace,
          pair: state.pair,
          roles: state.roles,
          owner: state.owner,
          revision: state.revision,
          loop_on: state.loop_on,
          stop_flag: state.stop_flag,
          whose_turn: state.whose_turn,
          rounds: state.rounds,
          budget_usd: state.budget_usd,
          active_turn: state.active_turn ?? null,
          last_attempt: state.last_attempt,
          dispatch: state.dispatch,
          pause: pauseReason(state, messages),
          messages: messages.map((m) => ({ file: m.file, author: m.author, status: m.status, in_reply_to: m.inReplyTo, run_key: m.runKey, task: m.task, valid: m.problems.length === 0 })),
        },
      };
    });
  }
}

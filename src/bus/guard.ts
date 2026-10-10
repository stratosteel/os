/**
 * Layer 4 machine channel: the loop guard's decisions, pure (no I/O, no clock reads; the caller passes the time).
 * Port of the decisions of the XS Lab loop guard (xs-lab tools/loop_guard.py: the turn check, the owner-wait and owner-stop checks, the budget gate,
 * the daily cap and the cooldown) with the owner role configurable and two deliberate tightenings:
 *  - a STOP holds while the latest owner message is a STOP, even when another message follows it (XS looked only at the
 *    very last message, so a role message written after the owner's STOP lifted it);
 *  - when the bus is empty or its last message is the owner's, only the role whose turn it is may start (the owner
 *    message's NEXT_OWNER, else whose_turn), so the two roles never race for the first turn.
 * The pause conditions apply to dispatch as well as to new turns (the budget check at handoff is the fail-closed patch's).
 * The STATUS view is a pure function of the state and the messages, byte for byte, so a cold reader can rebuild it from the
 * remote alone and compare it with the committed file.
 */
import { WAITING_MARKER, type BusMessage } from './messages.js';
import type { LoopState } from './state.js';

export interface Budget {
  valid: boolean;
  approved: number;
  spent: number;
  pauseAtRatio: number;
}

/** budget_usd = { approved > 0, spent_estimate >= 0, pause_at_ratio in (0, 1], default 0.8 }; anything else is invalid. */
export function budgetOf(state: LoopState): Budget {
  const b = state.budget_usd as { approved?: unknown; spent_estimate?: unknown; pause_at_ratio?: unknown } | null | undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);
  const approved = num(b?.approved);
  const spent = num(b?.spent_estimate);
  const ratio = b?.pause_at_ratio === undefined ? 0.8 : num(b.pause_at_ratio);
  const valid = approved > 0 && spent >= 0 && ratio > 0 && ratio <= 1;
  return { valid, approved, spent, pauseAtRatio: ratio };
}

/** The UTC day rolls the per-role round counters (as XS roll_day); the counted day of an attempt stays its start day. */
export function withRolledDay(state: LoopState, now: Date): LoopState {
  const today = now.toISOString().slice(0, 10);
  if (state.rounds.date === today) return state;
  return { ...state, rounds: { date: today, [state.roles[0]]: 0, [state.roles[1]]: 0 } };
}

export function roundsOf(state: LoopState, role: string): number {
  const v = state.rounds[role];
  return typeof v === 'number' ? v : 0;
}

/** The latest owner message is a STOP (status STOP, or the word STOP in its body, as the XS owner-stop check). */
export function ownerStopped(state: LoopState, messages: readonly BusMessage[]): boolean {
  const last = [...messages].reverse().find((m) => m.author === state.owner);
  return !!last && (last.status === 'STOP' || /\bSTOP\b/.test(last.body));
}

/** The last message is a role message asking for the owner (ACTION_REQUIRED or the marker): an owner message answers it. */
export function waitingForOwner(state: LoopState, messages: readonly BusMessage[]): boolean {
  const last = messages.at(-1);
  return !!last && last.author !== state.owner && (last.status === 'ACTION_REQUIRED' || last.body.includes(WAITING_MARKER));
}

/** Why no dispatch and no new turn may happen now, whoever asks; null when the loop may run. */
export function pauseReason(state: LoopState, messages: readonly BusMessage[]): string | null {
  const budget = budgetOf(state);
  if (!budget.valid) return 'budget state invalid; no turn';
  if (budget.spent >= budget.approved * budget.pauseAtRatio) {
    return `budget conservation threshold reached (spent ${budget.spent} of approved ${budget.approved}, pause at ${budget.pauseAtRatio}); no new turn`;
  }
  if (!state.loop_on) return 'loop_on is false';
  if (state.stop_flag) return 'stop_flag is set';
  if (ownerStopped(state, messages)) return 'the latest owner message is a STOP';
  if (waitingForOwner(state, messages)) return 'the last message waits for the owner';
  return null;
}

/** Cooldown since the role's last completion. A malformed or future completion time keeps it active (fail closed, as XS). */
export function cooldownActive(state: LoopState, role: string, now: Date): boolean {
  const stamp = state.last_run[role];
  if (stamp === undefined || stamp === null) return false;
  const at = typeof stamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(stamp) ? Date.parse(stamp) : Number.NaN;
  if (Number.isNaN(at)) return true;
  const elapsed = now.getTime() - at;
  return elapsed < 0 || elapsed < state.cooldown_seconds * 1000;
}

export interface TurnCheck {
  run: boolean;
  reason: string;
}

/** May `role` start a turn now? Same order as XS check: attempt, budget, loop, stop, owner, cap, cooldown, last author. */
export function checkTurn(state: LoopState, messages: readonly BusMessage[], role: string, now: Date): TurnCheck {
  if (!state.roles.includes(role)) {
    return { run: false, reason: `${role} is not a role of this bus (roles ${state.roles.join(', ')}; the owner never takes turns)` };
  }
  const s = withRolledDay(state, now);
  if (s.active_turn) {
    return { run: false, reason: `unfinalized role attempt by ${s.active_turn.role} (run key ${s.active_turn.run_key}); finalize it before another turn` };
  }
  const pause = pauseReason(s, messages);
  if (pause) return { run: false, reason: pause };
  const rounds = roundsOf(s, role);
  if (rounds >= s.max_rounds_per_day) return { run: false, reason: `daily cap reached for ${role} (${rounds} of ${s.max_rounds_per_day})` };
  if (cooldownActive(s, role, now)) return { run: false, reason: `cooldown active for ${role} (${s.cooldown_seconds} s after its last completion)` };
  const last = messages.at(-1);
  if (last && last.author === role) return { run: false, reason: `last message is by ${role} and nobody answered yet; nothing to do` };
  if (!last || last.author === s.owner) {
    const next = last && s.roles.includes(last.nextOwner) ? last.nextOwner : s.whose_turn;
    if (next && next !== role) return { run: false, reason: `the turn belongs to ${next}` };
  }
  return { run: true, reason: `turn for ${role}; last message ${last?.file ?? 'none'}` };
}

const clip = (v: string, n = 120) => (v.length > n ? `${v.slice(0, n)}...` : v);

/** The STATUS view: a pure function of the state and the messages. */
export function renderStatus(state: LoopState, messages: readonly BusMessage[]): string {
  const budget = budgetOf(state);
  const rounds = `rounds ${state.rounds.date}: ${state.roles.map((r) => `${r} ${roundsOf(state, r)}`).join(', ')}`;
  const money = budget.valid ? `budget: approved ${budget.approved}, spent ${budget.spent} (pause at ${budget.pauseAtRatio})` : 'budget: INVALID (no turn)';
  const active = state.active_turn ? `${state.active_turn.role} ${state.active_turn.run_key} since ${state.active_turn.started_at}` : 'none';
  const d = state.dispatch;
  const dispatch = d ? `to ${d.to} for \`${d.for}\`, ${d.status} after ${d.attempts} attempt(s)` : 'none';
  const lines = [
    `# BUS STATUS: ${state.pair}`,
    '',
    `Rebuilt by the stratosteel-os bus from state revision ${state.revision} and ${messages.length} messages; never edited by hand. Messages: \`${state.namespace}/coordination/${state.pair}/\` (immutable). State: \`${state.namespace}/state/loop.json\`.`,
    '',
    `loop_on: ${state.loop_on} · stop_flag: ${state.stop_flag} · whose_turn: ${state.whose_turn ?? 'none'} · ${rounds} · ${money}`,
    `active attempt: ${active}`,
    `last dispatch: ${dispatch}`,
    `pause: ${pauseReason(state, messages) ?? 'none'}`,
    '',
    '## Last 10 messages',
    '',
  ];
  for (const m of messages.slice(-10)) {
    lines.push(`- \`${m.file}\` · ${m.status || '?'} · task ${clip(m.task)} · done ${clip(m.done)} · evidence ${clip(m.evidence)} · next ${m.nextOwner} ${m.nextDate}${m.problems.length ? ` · INVALID: ${clip(m.problems.join('; '))}` : ''}`);
  }
  if (!messages.length) lines.push('- none');
  if (waitingForOwner(state, messages)) {
    lines.push('', `**WAITING FOR THE OWNER**: the last role message needs the owner's decision; the owner answers with a message by ${state.owner}; a STOP stops the loop.`);
  }
  return `${lines.join('\n')}\n`;
}

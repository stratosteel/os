/**
 * Layer 4 machine channel: the loop state file <namespace>/state/loop.json, the port of XS state/loop.json (loop_on,
 * stop_flag, max_rounds_per_day, rounds, whose_turn, budget_usd, active_turn, last_attempt, last_run) plus what the
 * fail-closed patch and this port add: the dispatch record (idempotent dispatch per last bus message, as a durable claim),
 * the cooldown and lease settings, and a revision fence.
 *
 * Revision fence: every write sets a fresh `revision` and keeps the previous one in `parent_revision`. Two writers that
 * start from the same state therefore always change the same line differently, so the second one's `pull --rebase`
 * stops with a conflict and its write fails closed; a write never merges silently into a state it did not read.
 * The file carries a schema marker; a state file without it (for example an XS state/loop.json) is never adopted.
 * Keys are written sorted, two-space indented, so diffs and conflicts stay line-precise.
 */
import * as z from 'zod/v4';
import { ROLE_ID, RUN_KEY } from './messages.js';

export const BUS_STATE_SCHEMA = 'stratosteel-os/bus-state/v0.1';

const Role = z.string().regex(ROLE_ID);
const Iso = z.string().min(1);

export const AttemptRecordSchema = z.object({
  role: Role,
  run_key: z.string().regex(RUN_KEY),
  started_at: Iso,
  count_date: z.string(),
  outcome: z.string(),
  previous_message: z.string().nullable(),
  event: z.string().nullable(),
  completed_at: Iso.optional(),
  model_outcome: z.string().optional(),
  recovered: z.boolean().optional(),
  role_message_preserved: z.boolean().optional(),
  cost_usd: z.number().nullable().optional(),
  cost_status: z.enum(['reported', 'unknown']).optional(),
}).loose();
export type AttemptRecord = z.infer<typeof AttemptRecordSchema>;

export const DispatchRecordSchema = z.object({
  /** The last bus message this dispatch wakes the other role for. */
  for: z.string(),
  to: Role,
  /** Claim token of the handoff process that owns the dispatch. */
  token: z.string(),
  claimed_at: Iso,
  status: z.enum(['claimed', 'sent', 'failed']),
  attempts: z.number().int().min(0),
  sent_at: Iso.optional(),
  error: z.string().optional(),
}).loose();
export type DispatchRecord = z.infer<typeof DispatchRecordSchema>;

export const LoopStateSchema = z.object({
  schema: z.literal(BUS_STATE_SCHEMA),
  revision: z.string().min(1),
  parent_revision: z.string().nullable(),
  namespace: z.string().min(1),
  pair: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
  roles: z.tuple([Role, Role]),
  owner: Role,
  loop_on: z.boolean(),
  stop_flag: z.boolean(),
  max_rounds_per_day: z.number().int().min(0),
  cooldown_seconds: z.number().int().min(0),
  dispatch_lease_seconds: z.number().int().min(1),
  max_dispatch_attempts: z.number().int().min(1),
  rounds: z.object({ date: z.string() }).catchall(z.union([z.number().int().min(0), z.string()])),
  whose_turn: Role.nullable(),
  /** Validated by the guard, not here: an invalid budget must stop turns, not crash the reader. */
  budget_usd: z.unknown(),
  active_turn: AttemptRecordSchema.optional(),
  last_attempt: z.record(z.string(), AttemptRecordSchema),
  /** Completion time per role; a malformed value keeps the cooldown active (fail closed), so it is not validated here. */
  last_run: z.record(z.string(), z.unknown()),
  dispatch: DispatchRecordSchema.nullable(),
}).loose();
export type LoopState = z.infer<typeof LoopStateSchema>;

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateError';
  }
}

/** Parse a state file. Anything but a valid stratosteel-os bus state is an explicit error, never an empty state. */
export function parseState(text: string): LoopState {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StateError('bus state is not valid JSON');
  }
  if ((data as { schema?: unknown } | null)?.schema !== BUS_STATE_SCHEMA) {
    throw new StateError(`not a ${BUS_STATE_SCHEMA} state: a foreign loop state (for example an XS state/loop.json) is never adopted`);
  }
  const parsed = LoopStateSchema.safeParse(data);
  if (!parsed.success) {
    throw new StateError(`bus state invalid: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  }
  if (parsed.data.roles[0] === parsed.data.roles[1] || parsed.data.roles.includes(parsed.data.owner)) {
    throw new StateError('bus state invalid: the two roles and the owner must be distinct');
  }
  return parsed.data;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** JSON with sorted keys, two-space indented, newline-terminated: stable diffs, line-precise conflicts. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export function serializeState(state: LoopState): string {
  return stableJson(state);
}

/** A copy of the state with a fresh revision: the fence every write passes through. */
export function revised(state: LoopState, revision: string): LoopState {
  return { ...structuredClone(state), parent_revision: state.revision, revision };
}

export function otherRole(state: LoopState, role: string): string {
  return state.roles[0] === role ? state.roles[1] : state.roles[0];
}

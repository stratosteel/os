#!/usr/bin/env node
/**
 * Command line of the bus (layer 4 machine channel), one command per process, as a workflow step would run it:
 *
 *   node dist/src/bus/cli.js init    --roles A,B --owner O --budget-approved USD [--budget-spent USD] [--pause-at-ratio R]
 *                                    [--max-rounds-per-day N] [--cooldown-seconds S] [--dispatch-lease-seconds S]
 *                                    [--max-dispatch-attempts N] [--pair NAME] [--first-turn A]
 *   node dist/src/bus/cli.js check   --role A
 *   node dist/src/bus/cli.js start   --role A --run-key K [--event FILE]
 *   node dist/src/bus/cli.js post    --role A [--run-key K] --status S --task T --done D --evidence E [--open O]
 *                                    [--next-owner X] [--next-date YYYY-MM-DD] [--in-reply-to FILE|auto|none]
 *                                    [--body TEXT | --body-file PATH]
 *   node dist/src/bus/cli.js handoff --role A --run-key K --outcome success|failure|cancelled|killed [--cost-usd N]
 *   node dist/src/bus/cli.js stop    [--reason TEXT]        (owner)
 *   node dist/src/bus/cli.js resume  [--reason TEXT]        (owner)
 *   node dist/src/bus/cli.js status  [--verify] [--write] [--no-sync]
 *
 * Common options (or environment): --repo DIR (OS_BUS_REPO, default the current directory: a dedicated clone),
 * --namespace NS (OS_BUS_NAMESPACE, default bus), --remote NAME (default origin), --branch NAME (OS_BUS_BRANCH,
 * default main), --dispatch-json JSON (OS_BUS_DISPATCH): the dispatcher as an argument vector without a shell, whose
 * arguments may contain {to}, {event} and {token}, for example
 *   ["gh","workflow","run","bus-{to}.yml","--ref","main","-f","event={event}"]
 * (it also receives OS_BUS_DISPATCH_TO, OS_BUS_DISPATCH_EVENT and OS_BUS_DISPATCH_TOKEN; exit 0 means sent),
 * --dispatch-timeout-ms N (default 60 000), --trace FILE (OS_BUS_TRACE): one JSON line per command and per dispatch,
 * metadata only.
 * Output: one JSON line on stdout. Exit 0: done (including check run=false, an already finalized or paused handoff);
 * exit 1: refused or failed, with the reason; exit 2: usage.
 */
import { spawn } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { GitCliPersistence, PersistenceError, sanitize, withWorkingCopyLock } from './git.js';
import { BusLoop, type BusResult, type Dispatcher, type InitOptions } from './loop.js';
import type { MessageStatus } from './messages.js';

class UsageError extends Error {}

const OPTIONS = {
  repo: { type: 'string' },
  namespace: { type: 'string' },
  remote: { type: 'string' },
  branch: { type: 'string' },
  'dispatch-json': { type: 'string' },
  'dispatch-timeout-ms': { type: 'string' },
  trace: { type: 'string' },
  role: { type: 'string' },
  roles: { type: 'string' },
  owner: { type: 'string' },
  'run-key': { type: 'string' },
  event: { type: 'string' },
  status: { type: 'string' },
  task: { type: 'string' },
  done: { type: 'string' },
  evidence: { type: 'string' },
  open: { type: 'string' },
  'next-owner': { type: 'string' },
  'next-date': { type: 'string' },
  'in-reply-to': { type: 'string' },
  body: { type: 'string' },
  'body-file': { type: 'string' },
  outcome: { type: 'string' },
  'cost-usd': { type: 'string' },
  reason: { type: 'string' },
  'budget-approved': { type: 'string' },
  'budget-spent': { type: 'string' },
  'pause-at-ratio': { type: 'string' },
  'max-rounds-per-day': { type: 'string' },
  'cooldown-seconds': { type: 'string' },
  'dispatch-lease-seconds': { type: 'string' },
  'max-dispatch-attempts': { type: 'string' },
  pair: { type: 'string' },
  'first-turn': { type: 'string' },
  verify: { type: 'boolean' },
  write: { type: 'boolean' },
  'no-sync': { type: 'boolean' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

function required(values: Values, name: keyof Values): string {
  const v = values[name];
  if (typeof v !== 'string' || !v.trim()) throw new UsageError(`--${String(name)} is required`);
  return v;
}

function number(values: Values, name: keyof Values): number | undefined {
  const v = values[name];
  if (v === undefined) return undefined;
  const n = typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new UsageError(`--${String(name)} must be a number`);
  return n;
}

async function trace(file: string | undefined, event: Record<string, unknown>): Promise<void> {
  if (!file) return;
  await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event })}\n`, 'utf8');
}

/** The dispatcher as an argument vector without a shell; placeholders {to}, {event}, {token}. */
export function commandDispatcher(argv: string[], timeoutMs: number, traceFile?: string): Dispatcher {
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string')) {
    throw new UsageError('the dispatcher must be a JSON array of strings, for example ["gh","workflow","run","bus-{to}.yml"]');
  }
  return async ({ to, event, token }) => {
    const args = argv.map((a) => a.replaceAll('{to}', to).replaceAll('{event}', event).replaceAll('{token}', token));
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; timedOut: boolean }>((resolve) => {
      const child = spawn(args[0], args.slice(1), {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, OS_BUS_DISPATCH_TO: to, OS_BUS_DISPATCH_EVENT: event, OS_BUS_DISPATCH_TOKEN: token },
      });
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stderr.on('data', (c) => (stderr += c));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: 127, signal: null, stderr: e.message, timedOut });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stderr, timedOut });
      });
    });
    await trace(traceFile, { op: 'dispatch', to, event, exit: result.code, timed_out: result.timedOut });
    if (result.code !== 0) {
      throw new Error(result.timedOut ? `dispatcher timed out after ${timeoutMs} ms (outcome unknown)` : `dispatcher exited with ${result.code ?? result.signal}: ${sanitize(result.stderr, 200)}`);
    }
  };
}

export async function main(argv: string[]): Promise<{ code: number; result: BusResult | { ok: false; op: string; reason: string } }> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    return { code: 2, result: { ok: false, op: 'usage', reason: e instanceof Error ? e.message : String(e) } };
  }
  const { values, positionals } = parsed;
  const op = positionals[0] ?? '';
  const traceFile = values.trace ?? process.env.OS_BUS_TRACE;
  try {
    if (!['init', 'check', 'start', 'post', 'handoff', 'stop', 'resume', 'status'].includes(op) || positionals.length !== 1) {
      throw new UsageError('command must be one of init, check, start, post, handoff, stop, resume, status');
    }
    const dir = path.resolve(values.repo ?? process.env.OS_BUS_REPO ?? '.');
    const namespace = values.namespace ?? process.env.OS_BUS_NAMESPACE ?? 'bus';
    const dispatchJson = values['dispatch-json'] ?? process.env.OS_BUS_DISPATCH;
    let dispatch: Dispatcher | undefined;
    if (dispatchJson) {
      let argvJson: unknown;
      try {
        argvJson = JSON.parse(dispatchJson);
      } catch {
        throw new UsageError('the dispatcher is not valid JSON');
      }
      dispatch = commandDispatcher(argvJson as string[], number(values, 'dispatch-timeout-ms') ?? 60_000, traceFile);
    }
    const run = async (): Promise<BusResult> => {
      const persistence = new GitCliPersistence({ dir, namespace, remote: values.remote, branch: values.branch ?? process.env.OS_BUS_BRANCH, recoverIndexLock: true });
      const loop = new BusLoop({ dir, namespace, persistence, dispatch });
      switch (op) {
        case 'init': {
          const roles = required(values, 'roles').split(',').map((r) => r.trim());
          if (roles.length !== 2) throw new UsageError('--roles takes exactly two role ids, comma separated');
          const opts: InitOptions = {
            roles: [roles[0], roles[1]],
            owner: required(values, 'owner'),
            budgetApproved: number(values, 'budget-approved') ?? Number.NaN,
            budgetSpent: number(values, 'budget-spent'),
            pauseAtRatio: number(values, 'pause-at-ratio'),
            maxRoundsPerDay: number(values, 'max-rounds-per-day'),
            cooldownSeconds: number(values, 'cooldown-seconds'),
            dispatchLeaseSeconds: number(values, 'dispatch-lease-seconds'),
            maxDispatchAttempts: number(values, 'max-dispatch-attempts'),
            pair: values.pair,
            firstTurn: values['first-turn'],
          };
          return loop.init(opts);
        }
        case 'check':
          return loop.check(required(values, 'role'));
        case 'start':
          return loop.start(required(values, 'role'), required(values, 'run-key'), values.event);
        case 'post': {
          const bodyFile = values['body-file'];
          const body = bodyFile ? await readFile(bodyFile, 'utf8') : values.body;
          return loop.post(required(values, 'role'), values['run-key'], {
            status: required(values, 'status') as MessageStatus,
            task: required(values, 'task'),
            done: required(values, 'done'),
            evidence: required(values, 'evidence'),
            open: values.open,
            nextOwner: values['next-owner'],
            nextDate: values['next-date'],
            inReplyTo: values['in-reply-to'],
            body,
          });
        }
        case 'handoff':
          return loop.handoff(required(values, 'role'), required(values, 'run-key'), required(values, 'outcome'), values['cost-usd'] === undefined ? undefined : Number(values['cost-usd']));
        case 'stop':
          return loop.stop(values.reason);
        case 'resume':
          return loop.resume(values.reason);
        default:
          return loop.status({ sync: !values['no-sync'], verify: values.verify, write: values.write });
      }
    };
    const result = await withWorkingCopyLock(dir, run);
    await trace(traceFile, { op, role: values.role ?? null, run_key: values['run-key'] ?? null, event: values.event ?? null, ok: result.ok, reason: result.reason, run: result.run ?? null, dispatched: result.dispatched ?? null, file: result.file ?? null });
    return { code: result.ok ? 0 : 1, result };
  } catch (e) {
    const usage = e instanceof UsageError;
    const reason = e instanceof PersistenceError ? `${e.step}: ${e.message}` : sanitize(e instanceof Error ? e.message : String(e), 500);
    await trace(traceFile, { op: op || 'usage', role: values.role ?? null, run_key: values['run-key'] ?? null, ok: false, reason }).catch(() => undefined);
    return { code: usage ? 2 : 1, result: { ok: false, op: op || 'usage', reason } };
  }
}

const isMain = process.argv[1] && /bus[\\/]cli\.js$/.test(process.argv[1]);
if (isMain) {
  const { code, result } = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.stderr.write(`bus ${result.op}: ${result.reason}\n`);
  process.exitCode = code;
}

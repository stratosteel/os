/**
 * One role turn as an independent OS process, the way a scheduled or dispatched workflow run would do it:
 *   node dist/test/fixtures/bus_role_runner.js <config.json>
 * It clones the bus remote into its own fresh working copy (no state shared with any other process), then runs the bus
 * CLI steps as child processes: check, start (the reservation with its run key), post (one handover message, metadata
 * only), handoff (finalize, dispatch the other role). A failed post still ends with handoff (as the XS finalizer step
 * always runs), with the outcome failure. It prints "result:<json>" with every step's CLI output.
 * Test-only controls (never in the bus code): a one-shot post-commit barrier hook in its clone so that two runners'
 * first commits wait for each other; pausing after start until killed.
 */
import { spawn } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface RunnerConfig {
  cli: string;
  remote: string;
  workdir: string;
  role: string;
  runKey: string;
  event?: string | null;
  trace: string;
  dispatchArgv?: string[];
  task?: string;
  costUsd?: number;
  /** Install a one-shot post-commit hook that waits until `count` runners have committed. */
  barrier?: { dir: string; count: number };
  /** Print "paused:start" after the reservation and wait to be killed. */
  pauseAfterStart?: boolean;
}

interface Step {
  step: string;
  code: number;
  result: Record<string, unknown> | null;
}

const config = JSON.parse(await readFile(process.argv[2], 'utf8')) as RunnerConfig;
const steps: Step[] = [];

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function cli(step: string, args: string[]): Promise<Step> {
  const r = await run(process.execPath, [config.cli, ...args, '--repo', config.workdir, '--trace', config.trace]);
  let result: Record<string, unknown> | null = null;
  try {
    result = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>;
  } catch {
    result = { unparsable: r.stdout, stderr: r.stderr };
  }
  const s = { step, code: r.code, result };
  steps.push(s);
  return s;
}

async function finish(extra: Record<string, unknown>): Promise<never> {
  const line = `result:${JSON.stringify({ role: config.role, run_key: config.runKey, event: config.event ?? null, pid: process.pid, steps, ...extra })}\n`;
  await new Promise<void>((resolve) => process.stdout.write(line, () => resolve()));
  process.exit(0);
}

const cloned = await run('git', ['clone', '--quiet', config.remote, config.workdir]);
if (cloned.code !== 0) await finish({ error: `clone failed: ${cloned.stderr}` });

if (config.barrier) {
  const hook = path.join(config.workdir, '.git', 'hooks', 'post-commit');
  const marker = path.join(config.barrier.dir, `${process.pid}`);
  await writeFile(hook, [
    '#!/bin/sh',
    `[ -e '${marker}' ] && exit 0`,
    `touch '${marker}'`,
    'i=0',
    `while [ "$(ls '${config.barrier.dir}' | wc -l)" -lt ${config.barrier.count} ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done`,
    'exit 0',
    '',
  ].join('\n'), 'utf8');
  await chmod(hook, 0o755);
}

const check = await cli('check', ['check', '--role', config.role]);
if (check.result?.run !== true) await finish({ outcome: 'skipped', reason: check.result?.reason ?? null });

const start = await cli('start', ['start', '--role', config.role, '--run-key', config.runKey, ...(config.event ? ['--event', config.event] : [])]);
if (start.code !== 0) await finish({ outcome: 'refused', reason: start.result?.reason ?? null });

if (config.pauseAfterStart) {
  process.stdout.write('paused:start\n');
  await new Promise(() => undefined);
}

const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const post = await cli('post', [
  'post', '--role', config.role, '--run-key', config.runKey, '--status', 'DONE',
  '--task', config.task ?? 'T-gate', '--done', `handover by ${config.role} in ${config.runKey}`,
  '--evidence', `run ${config.runKey}`, '--open', 'reply expected from the other role', '--next-date', tomorrow,
  '--in-reply-to', config.event ?? 'auto',
]);
const handoff = await cli('handoff', [
  'handoff', '--role', config.role, '--run-key', config.runKey, '--outcome', post.code === 0 ? 'success' : 'failure',
  ...(config.costUsd === undefined ? [] : ['--cost-usd', String(config.costUsd)]),
  ...(config.dispatchArgv ? ['--dispatch-json', JSON.stringify(config.dispatchArgv)] : []),
]);
await finish({ outcome: handoff.code === 0 ? 'turn' : 'handoff_failed', reason: handoff.result?.reason ?? null });

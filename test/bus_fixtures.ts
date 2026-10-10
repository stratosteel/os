/**
 * Shared fixtures and evidence helpers for the bus tests (layer 4 machine channel). Generic roles (role-a, role-b,
 * owner) and generic task ids only; no company data.
 *
 * A workspace is a temporary directory with a bare git remote created by `git init --bare` (seeded with one commit, as an
 * existing repository would be), working copies cloned from it, and git isolated from the host's configuration
 * (GIT_CONFIG_GLOBAL pointing at an empty file, GIT_CONFIG_NOSYSTEM=1), so the tests behave the same here and in CI.
 * Evidence (the process trace, the dispatch counter and queue, the message files, the state before and after, the remote
 * log) is written under <tmp>/evidence, or under $OS_EVIDENCE_DIR/<case>-<tmp name> when it is set, and every path is
 * printed as a test diagnostic.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../src/bus/cli.js', import.meta.url));
export const RUNNER = fileURLToPath(new URL('./fixtures/bus_role_runner.js', import.meta.url));
export const DISPATCH_RECORDER = fileURLToPath(new URL('./fixtures/bus_dispatch_record.js', import.meta.url));
export const NS = 'bus';
export const PAIR = 'role-a_role-b';

export interface BusWorkspace {
  name: string;
  root: string;
  remote: string;
  evidenceDir: string;
  /** Process trace: one JSON line per CLI command, per dispatch and per scheduler action. */
  trace: string;
  /** Dispatch counter and event queue: one JSON line per dispatcher call. */
  queue: string;
  env: NodeJS.ProcessEnv;
}

export interface Exec {
  code: number;
  stdout: string;
  stderr: string;
}

export function exec(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Exec> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function git(ws: BusWorkspace, args: string[], cwd?: string): Promise<string> {
  const r = await exec('git', args, { cwd: cwd ?? ws.root, env: ws.env });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

export async function busWorkspace(caseName: string): Promise<BusWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), `os-bus-${caseName}-`));
  const base = process.env.OS_EVIDENCE_DIR;
  const evidenceDir = base ? path.join(path.resolve(base), `${caseName}-${path.basename(root)}`) : path.join(root, 'evidence');
  await mkdir(evidenceDir, { recursive: true });
  const gitconfig = path.join(root, 'empty.gitconfig');
  await writeFile(gitconfig, '', 'utf8');
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('OS_BUS_')) delete env[k];
  const ws: BusWorkspace = { name: caseName, root, remote: path.join(root, 'remote.git'), evidenceDir, trace: path.join(evidenceDir, 'process_trace.jsonl'), queue: path.join(evidenceDir, 'dispatch_queue.jsonl'), env };
  await writeFile(ws.trace, '', 'utf8');
  await writeFile(ws.queue, '', 'utf8');
  await git(ws, ['init', '--quiet', '--bare', '--initial-branch=main', ws.remote]);
  const seed = path.join(root, 'clones', 'seed');
  await git(ws, ['clone', '--quiet', ws.remote, seed]);
  await writeFile(path.join(seed, 'README.md'), 'test repository of the bus gate tests\n', 'utf8');
  await git(ws, ['add', 'README.md'], seed);
  await git(ws, ['-c', 'user.name=seed', '-c', 'user.email=seed@example.invalid', 'commit', '--quiet', '-m', 'seed'], seed);
  await git(ws, ['push', '--quiet', 'origin', 'HEAD:main'], seed);
  return ws;
}

let cloneCounter = 0;
/** A fresh working copy of the remote: an independent machine with no local state. */
export async function freshClone(ws: BusWorkspace, label = 'wc'): Promise<string> {
  cloneCounter += 1;
  const dir = path.join(ws.root, 'clones', `${label}-${cloneCounter}`);
  await git(ws, ['clone', '--quiet', ws.remote, dir]);
  return dir;
}

export function dispatchArgv(ws: BusWorkspace): string[] {
  return [process.execPath, DISPATCH_RECORDER, ws.queue, '{to}', '{event}', '{token}'];
}

export interface CliRun {
  code: number;
  result: Record<string, any>;
  stderr: string;
}

/** One bus CLI command as its own OS process, in the given working copy, with the workspace trace. */
export async function cli(ws: BusWorkspace, repo: string, args: string[], opts: { dispatch?: boolean | string[] } = {}): Promise<CliRun> {
  const dispatch = opts.dispatch === true ? dispatchArgv(ws) : opts.dispatch || undefined;
  const r = await exec(process.execPath, [CLI, ...args, '--repo', repo, '--trace', ws.trace, ...(dispatch ? ['--dispatch-json', JSON.stringify(dispatch)] : [])], { env: ws.env });
  let result: Record<string, any>;
  try {
    result = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as Record<string, any>;
  } catch {
    result = { unparsable: r.stdout };
  }
  return { code: r.code, result, stderr: r.stderr };
}

/** Spawn a CLI command and return the child, for races and crashes (detached: its own process group). */
export function spawnCli(ws: BusWorkspace, repo: string, args: string[], dispatch = false): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [CLI, ...args, '--repo', repo, '--trace', ws.trace, ...(dispatch ? ['--dispatch-json', JSON.stringify(dispatchArgv(ws))] : [])], { env: ws.env, detached: true });
}

export async function initBus(ws: BusWorkspace, extra: string[] = []): Promise<CliRun> {
  const wc = await freshClone(ws, 'init');
  const r = await cli(ws, wc, ['init', '--roles', 'role-a,role-b', '--owner', 'owner', '--budget-approved', '10', '--cooldown-seconds', '0', ...extra]);
  if (r.code !== 0) throw new Error(`init failed: ${JSON.stringify(r.result)}`);
  return r;
}

export interface RunnerResult {
  code: number;
  role: string;
  run_key: string;
  event: string | null;
  outcome?: string;
  reason?: string | null;
  steps: { step: string; code: number; result: Record<string, any> }[];
  [key: string]: unknown;
}

export interface RunnerOptions {
  role: string;
  runKey: string;
  event?: string | null;
  task?: string;
  costUsd?: number;
  dispatch?: boolean;
  barrier?: { dir: string; count: number };
  pauseAfterStart?: boolean;
}

/** Start one role runner process (node dist/test/fixtures/bus_role_runner.js) and return the child. */
export async function spawnRunner(ws: BusWorkspace, o: RunnerOptions): Promise<{ child: ChildProcessWithoutNullStreams; result: Promise<RunnerResult>; paused: Promise<void> }> {
  const safe = o.runKey.replace(/[^A-Za-z0-9._-]/g, '_');
  const runDir = path.join(ws.root, 'runs', `${safe}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await mkdir(runDir, { recursive: true });
  const configPath = path.join(runDir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    cli: CLI, remote: ws.remote, workdir: path.join(runDir, 'wc'), role: o.role, runKey: o.runKey, event: o.event ?? null,
    trace: ws.trace, dispatchArgv: o.dispatch === false ? undefined : dispatchArgv(ws), task: o.task, costUsd: o.costUsd,
    barrier: o.barrier, pauseAfterStart: o.pauseAfterStart,
  }, null, 2), 'utf8');
  const child = spawn(process.execPath, [RUNNER, configPath], { env: ws.env, detached: true });
  let out = '';
  let err = '';
  let markPaused!: () => void;
  const paused = new Promise<void>((resolve) => (markPaused = resolve));
  child.stdout.on('data', (c) => {
    out += c;
    if (out.includes('paused:start\n')) markPaused();
  });
  child.stderr.on('data', (c) => (err += c));
  const result = new Promise<RunnerResult>((resolve, reject) => {
    child.on('exit', (code, signal) => {
      const line = out.split('\n').find((l) => l.startsWith('result:'));
      if (!line) {
        if (signal) return resolve({ code: -1, role: o.role, run_key: o.runKey, event: o.event ?? null, outcome: `killed by ${signal}`, steps: [] });
        return reject(new Error(`runner ${o.runKey} gave no result (exit ${code}): ${err}`));
      }
      resolve({ code: code ?? -1, ...(JSON.parse(line.slice('result:'.length)) as object) } as RunnerResult);
    });
  });
  return { child, result, paused };
}

export async function runRole(ws: BusWorkspace, o: RunnerOptions): Promise<RunnerResult> {
  return (await spawnRunner(ws, o)).result;
}

export interface Dispatch {
  at: string;
  pid: number;
  to: string;
  event: string;
  token: string;
}

export async function readQueue(ws: BusWorkspace): Promise<Dispatch[]> {
  return (await readFile(ws.queue, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Dispatch);
}

export async function traceEvent(ws: BusWorkspace, event: Record<string, unknown>): Promise<void> {
  await appendFile(ws.trace, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event })}\n`, 'utf8');
}

/**
 * The fake scheduler, the role GitHub Actions plays in production: it starts the first run, then starts one run per
 * dispatch the bus makes (each in a fresh clone, with a new run key), until no dispatch is left. No person in the loop.
 */
export async function driveChain(ws: BusWorkspace, first: { to: string; event?: string | null }, maxRuns = 12): Promise<RunnerResult[]> {
  const runs: RunnerResult[] = [];
  const pending: { to: string; event: string | null }[] = [{ to: first.to, event: first.event ?? null }];
  let consumed = (await readQueue(ws)).length;
  let n = 0;
  while (pending.length) {
    n += 1;
    if (n > maxRuns) throw new Error(`runaway chain: more than ${maxRuns} runs`);
    const next = pending.shift()!;
    const runKey = `sched-${n}:1`;
    await traceEvent(ws, { op: 'scheduler', action: 'start run', role: next.to, run_key: runKey, event: next.event });
    const r = await runRole(ws, { role: next.to, runKey, event: next.event });
    await traceEvent(ws, { op: 'scheduler', action: 'run ended', role: next.to, run_key: runKey, outcome: r.outcome ?? null, reason: r.reason ?? null });
    runs.push(r);
    const queue = await readQueue(ws);
    for (const d of queue.slice(consumed)) pending.push({ to: d.to, event: d.event });
    consumed = queue.length;
  }
  return runs;
}

export async function remoteFile(ws: BusWorkspace, file: string, ref = 'main'): Promise<string | null> {
  const r = await exec('git', ['--git-dir', ws.remote, 'show', `${ref}:${file}`], { env: ws.env });
  return r.code === 0 ? r.stdout : null;
}

export async function remoteState(ws: BusWorkspace, ref = 'main'): Promise<Record<string, any>> {
  const text = await remoteFile(ws, `${NS}/state/loop.json`, ref);
  if (text === null) throw new Error('no bus state on the remote');
  return JSON.parse(text) as Record<string, any>;
}

export async function remoteHead(ws: BusWorkspace): Promise<string> {
  return (await git(ws, ['--git-dir', ws.remote, 'rev-parse', 'main'])).trim();
}

export async function remoteLog(ws: BusWorkspace): Promise<string> {
  return git(ws, ['--git-dir', ws.remote, 'log', '--format=%h %an | %s', '--name-status', 'main']);
}

/** Commit subjects on the remote, newest first. */
export async function remoteSubjects(ws: BusWorkspace): Promise<string[]> {
  return (await git(ws, ['--git-dir', ws.remote, 'log', '--format=%s', 'main'])).split('\n').filter(Boolean);
}

/** Install an executable hook (sh) in a working copy or a bare remote. */
export async function installHook(gitDir: string, name: string, script: string): Promise<string> {
  const file = path.join(gitDir, 'hooks', name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\n${script}\n`, 'utf8');
  await chmod(file, 0o755);
  return file;
}

/**
 * Write the evidence files of a case and print every path. Message files are copied from a fresh clone of the remote,
 * so they are exactly what the remote holds.
 */
export async function persistBusEvidence(t: TestContext, ws: BusWorkspace, files: Record<string, unknown>): Promise<void> {
  const written: string[] = [ws.trace, ws.queue];
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(ws.evidenceDir, name);
    await writeFile(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, 'utf8');
    written.push(file);
  }
  const reader = await freshClone(ws, 'evidence');
  const msgDir = path.join(reader, NS, 'coordination', PAIR);
  const target = path.join(ws.evidenceDir, 'messages');
  await mkdir(target, { recursive: true });
  let copied = 0;
  for (const name of await readdir(msgDir).catch(() => [] as string[])) {
    if (!name.endsWith('.md')) continue;
    await copyFile(path.join(msgDir, name), path.join(target, name));
    copied += 1;
  }
  written.push(`${target} (${copied} message files)`);
  const log = path.join(ws.evidenceDir, 'remote_log.txt');
  await writeFile(log, await remoteLog(ws), 'utf8');
  written.push(log);
  t.diagnostic(`evidence ${ws.name}: ${ws.evidenceDir}`);
  for (const w of written) t.diagnostic(`  ${w}`);
}

/** Wait until a predicate holds, polling (for files written by other processes). */
export async function waitFor(what: string, predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

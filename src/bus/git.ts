/**
 * Layer 4 machine channel: persistence of the bus through git, fail closed (the port of XS persist_control with the
 * restore the fail-closed patch added).
 *
 * Every bus command starts with sync(): the working copy is brought to the remote head, and leftovers of a crashed run
 * inside the namespace (an unpushed commit, a half-written file) are discarded, because the remote is the truth. A change
 * outside the namespace makes sync refuse: the bus needs a dedicated clone and never discards someone else's work.
 * persist() commits what changed under the namespace, pulls with rebase and pushes (3 attempts, as XS). Any failure (the
 * commit, a rebase conflict, a rejected or impossible push) restores the working copy to the head of the last sync, so the
 * local state is the previous state again, and throws a PersistenceError with an explicit reason; the caller then
 * dispatches nothing and returns a non-zero result. One residual case is reported, not hidden: a push that reached the
 * remote but answered with an error leaves the commit on the remote; the next sync shows it.
 * git runs without a shell, without prompts (GIT_TERMINAL_PROMPT=0), in the C locale and without inherited repository
 * overrides such as GIT_DIR; credentials in URLs are redacted from every message.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { GITHUB_TOKEN_SHAPE } from '../manifest.js';

export type PersistenceStep = 'sync' | 'commit' | 'rebase' | 'push' | 'restore';

export class PersistenceError extends Error {
  constructor(readonly step: PersistenceStep, message: string) {
    super(message);
    this.name = 'PersistenceError';
  }
}

export interface Author {
  name: string;
  email: string;
}

export interface PersistResult {
  /** Head of the working copy after the push (equal to the remote head). */
  head: string;
  /** The commit made, or null when nothing under the namespace changed. */
  commit: string | null;
}

/** How the bus reaches its durable store. The git CLI implementation is below; tests may inject failures through it. */
export interface GitPersistence {
  /** Bring the working copy to the remote head; returns that head. */
  sync(): Promise<string>;
  /** Commit the namespace changes, pull --rebase, push. On failure: restore the last synced head and throw PersistenceError. */
  persist(message: string, author: Author): Promise<PersistResult>;
}

export interface GitCliOptions {
  /** Root of the working copy (a dedicated clone). */
  dir: string;
  /** Directory of the bus inside the working copy, relative; nothing outside it is staged, cleaned or committed. */
  namespace: string;
  remote?: string;
  branch?: string;
  /** Environment of the git processes (default process.env); tests isolate git from the host's global configuration. */
  env?: NodeJS.ProcessEnv;
  /** Push attempts, each after a pull --rebase (default 3, as XS). */
  pushAttempts?: number;
  /** Delay between push attempts, in ms (default 200, growing linearly). */
  retryDelayMs?: number;
  /**
   * Remove a leftover .git/index.lock at sync, as a crashed git process leaves it. Safe only while the caller holds the
   * working-copy lock (withWorkingCopyLock), which the CLI does; off by default.
   */
  recoverIndexLock?: boolean;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Variables that would make git act on another repository than the working copy in `cwd`, or sign the bus's commits with
 * another identity or date (git exports them to hooks, and a CI step may set them). The bus always acts on its configured
 * working copy under its own role identity, so they are removed.
 */
const INHERITED_OVERRIDES = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
];

export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', LC_ALL: 'C', LANG: 'C' };
  for (const k of INHERITED_OVERRIDES) delete env[k];
  return env;
}

/** Bounded, single-line, with credentials in URLs and token-shaped strings removed. */
export function sanitize(text: string, max = 300): string {
  const out = text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1[redacted]@')
    .replace(GITHUB_TOKEN_SHAPE, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

/** A relative directory without empty, '.', '..' or '.git' segments: the bus never writes outside it. */
export function namespaceErrors(ns: unknown): string[] {
  if (typeof ns !== 'string' || !ns.trim()) return ['namespace is empty'];
  const segments = ns.split('/');
  if (ns.startsWith('/') || segments.some((s) => !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(s) || s === '.git')) {
    return ['namespace must be a relative directory such as bus or bus/pair-1 (letters, digits, dot, underscore, hyphen; no ., .. or .git)'];
  }
  return [];
}

export class GitCliPersistence implements GitPersistence {
  private readonly remote: string;
  private readonly branch: string;
  private readonly pushAttempts: number;
  private readonly retryDelayMs: number;
  private syncedHead: string | null = null;

  constructor(private readonly opts: GitCliOptions) {
    const errors = namespaceErrors(opts.namespace);
    if (errors.length) throw new PersistenceError('sync', errors.join('; '));
    this.remote = opts.remote ?? 'origin';
    this.branch = opts.branch ?? 'main';
    this.pushAttempts = opts.pushAttempts ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 200;
  }

  private git(args: string[]): Promise<Run> {
    return new Promise((resolve) => {
      const child = spawn('git', args, { cwd: this.opts.dir, env: gitEnv(this.opts.env), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('error', (e) => resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` }));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }

  private async must(step: PersistenceStep, what: string, args: string[]): Promise<string> {
    const r = await this.git(args);
    if (r.code !== 0) throw new PersistenceError(step, `${what} failed: ${sanitize(r.stderr || r.stdout)}`);
    return r.stdout.trim();
  }

  private async gitDir(): Promise<string> {
    return path.resolve(this.opts.dir, await this.must('sync', 'locating the git directory', ['rev-parse', '--git-dir']));
  }

  private async rebaseInProgress(): Promise<boolean> {
    const dir = await this.gitDir();
    return existsSync(path.join(dir, 'rebase-merge')) || existsSync(path.join(dir, 'rebase-apply'));
  }

  private insideNamespace(p: string): boolean {
    const ns = this.opts.namespace.replace(/\/+$/, '');
    return p === ns || p.startsWith(`${ns}/`);
  }

  /** Paths changed or untracked in the working copy (porcelain v1, NUL separated). */
  private async dirtyPaths(): Promise<string[]> {
    const out = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (out.code !== 0) throw new PersistenceError('sync', `git status failed: ${sanitize(out.stderr)}`);
    const parts = out.stdout.split('\0').filter(Boolean);
    const paths: string[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const entry = parts[i];
      paths.push(entry.slice(3));
      if (entry[0] === 'R' || entry[0] === 'C') {
        i += 1;
        paths.push(parts[i]);
      }
    }
    return paths;
  }

  async sync(): Promise<string> {
    const top = await this.must('sync', 'reading the working copy root', ['rev-parse', '--show-toplevel']);
    if ((await realpath(top)) !== (await realpath(this.opts.dir))) {
      throw new PersistenceError('sync', 'the bus runs at the root of its working copy, not in a subdirectory');
    }
    if (this.opts.recoverIndexLock) await unlink(path.join(await this.gitDir(), 'index.lock')).catch(() => undefined);
    if (await this.rebaseInProgress()) await this.git(['rebase', '--abort']);
    const outside = (await this.dirtyPaths()).filter((p) => !this.insideNamespace(p));
    if (outside.length) {
      throw new PersistenceError('sync', `the working copy has changes outside the bus namespace (${outside.slice(0, 3).join(', ')}); the bus needs a dedicated clone and discards nothing outside its namespace`);
    }
    await this.must('sync', `fetching ${this.remote} ${this.branch}`, ['fetch', '--quiet', this.remote, this.branch]);
    const remoteHead = await this.must('sync', 'reading the fetched head', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    const local = await this.git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (local.code === 0) {
      const ahead = (await this.must('sync', 'listing local commits', ['rev-list', `${remoteHead}..HEAD`])).split('\n').filter(Boolean);
      for (const commit of ahead) {
        const touched = (await this.must('sync', 'reading a local commit', ['diff-tree', '--no-commit-id', '--name-only', '-r', commit])).split('\n').filter(Boolean);
        const foreign = touched.filter((p) => !this.insideNamespace(p));
        if (foreign.length) {
          throw new PersistenceError('sync', `local commit ${commit.slice(0, 12)} is not on the remote and touches files outside the bus namespace (${foreign.slice(0, 3).join(', ')}); refusing to discard it`);
        }
      }
    }
    await this.must('sync', 'resetting to the remote head', ['reset', '--hard', '--quiet', remoteHead]);
    await this.must('sync', 'cleaning the namespace', ['clean', '-fdq', '--', this.opts.namespace]);
    this.syncedHead = remoteHead;
    return remoteHead;
  }

  /** Back to the head of the last sync: the previous state. */
  private async restore(): Promise<void> {
    if (!this.syncedHead) return;
    if (await this.rebaseInProgress()) await this.git(['rebase', '--abort']);
    await this.must('restore', 'restoring the previous head', ['reset', '--hard', '--quiet', this.syncedHead]);
    await this.must('restore', 'cleaning the namespace', ['clean', '-fdq', '--', this.opts.namespace]);
    const head = await this.must('restore', 'reading the restored head', ['rev-parse', 'HEAD']);
    const dirty = (await this.dirtyPaths()).filter((p) => this.insideNamespace(p));
    if (head !== this.syncedHead || dirty.length) {
      throw new PersistenceError('restore', `the working copy could not be restored to ${this.syncedHead.slice(0, 12)}`);
    }
  }

  async persist(message: string, author: Author): Promise<PersistResult> {
    if (!this.syncedHead) throw new PersistenceError('commit', 'persist without a preceding sync');
    const identity = ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`];
    try {
      await this.must('commit', 'staging the namespace', ['add', '-A', '--', this.opts.namespace]);
      const staged = await this.git(['diff', '--cached', '--quiet', '--', this.opts.namespace]);
      if (staged.code === 0) return { head: this.syncedHead, commit: null };
      await this.must('commit', 'commit', [...identity, 'commit', '--quiet', '-m', message]);
      let lastPush = '';
      for (let attempt = 1; attempt <= this.pushAttempts; attempt += 1) {
        const pull = await this.git([...identity, 'pull', '--rebase', '--no-autostash', '--quiet', this.remote, this.branch]);
        if (pull.code !== 0) {
          if (await this.rebaseInProgress()) {
            const conflicted = (await this.git(['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
            await this.git(['rebase', '--abort']);
            throw new PersistenceError('rebase', `rebase conflict: the remote changed ${conflicted.length ? conflicted.join(', ') : 'the same files'} since this command read it; nothing was pushed`);
          }
          throw new PersistenceError('rebase', `pull --rebase from ${this.remote} ${this.branch} failed: ${sanitize(pull.stderr || pull.stdout)}`);
        }
        const push = await this.git(['push', '--quiet', this.remote, `HEAD:${this.branch}`]);
        if (push.code === 0) {
          // After a rebase onto newer remote commits the pushed commit is the rebased one, the new head.
          const head = await this.must('push', 'reading the pushed head', ['rev-parse', 'HEAD']);
          this.syncedHead = head;
          return { head, commit: head };
        }
        lastPush = sanitize(push.stderr || push.stdout);
        if (attempt < this.pushAttempts) await sleep(this.retryDelayMs * attempt);
      }
      throw new PersistenceError('push', `push to ${this.remote} ${this.branch} failed after ${this.pushAttempts} attempts: ${lastPush}`);
    } catch (e) {
      const failure = e instanceof PersistenceError ? e : new PersistenceError('commit', sanitize(e instanceof Error ? e.message : String(e)));
      try {
        await this.restore();
      } catch (r) {
        throw new PersistenceError('restore', `${failure.message}; restoring the previous state also failed: ${r instanceof Error ? r.message : String(r)}`);
      }
      throw failure;
    }
  }
}

/**
 * One bus command at a time per working copy: a lock file in the git directory, created exclusively. A lock whose process
 * no longer exists is stale and is taken over; a live one makes the command refuse.
 */
export async function withWorkingCopyLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const r = await new Promise<Run>((resolve) => {
    const child = spawn('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  if (r.code !== 0) throw new PersistenceError('sync', `${dir} is not a git working copy: ${sanitize(r.stderr)}`);
  const lock = path.join(path.resolve(dir, r.stdout.trim()), 'stratosteel-os-bus.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lock, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) {
        throw new PersistenceError('sync', `another bus command holds the working copy lock ${lock}`);
      }
      let pid = 0;
      try {
        pid = Number((JSON.parse(await readFile(lock, 'utf8')) as { pid?: unknown }).pid) || 0;
      } catch {
        pid = 0;
      }
      let alive = false;
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (err) {
          alive = (err as NodeJS.ErrnoException).code === 'EPERM';
        }
      }
      if (alive) throw new PersistenceError('sync', `another bus command (pid ${pid}) is running in this working copy`);
      await unlink(lock).catch(() => undefined);
    }
  }
  try {
    return await work();
  } finally {
    await unlink(lock).catch(() => undefined);
  }
}

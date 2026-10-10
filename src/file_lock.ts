/**
 * Exclusive lock files and durable writes for the file-backed stores (send records, the fake transport).
 *
 * The lock is the ApprovalQueue design generalized: a lock file created with 'wx' carries a random token; a lock older
 * than the stale timeout was left by a crashed holder and is broken after it has been moved aside and checked to be the
 * very file judged stale; a held lock fails explicitly after the timeout. ApprovalQueue keeps its own copy unchanged.
 *
 * The lock serializes writers; it is not the correctness argument. The send record store re-reads after every append and
 * a deterministic reducer decides which events are valid (send_record.ts), so a lock broken under a stopped holder cannot
 * produce two winners. Requires a local POSIX filesystem (O_APPEND and link() semantics), not NFS.
 */
import { link, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface FileLockOptions {
  /** How long to wait for the lock before failing with an explicit error, in milliseconds (default 10 000). */
  timeoutMs?: number;
  /** A lock older than this was left by a crashed holder and is broken, in milliseconds (default 30 000). */
  staleMs?: number;
}

export const errorCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function lockToken(content: string): unknown {
  try {
    return (JSON.parse(content) as { token?: unknown }).token;
  } catch {
    return undefined;
  }
}

async function tryLock(lockPath: string, token: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (e) {
    if (errorCode(e) === 'EEXIST') return false;
    throw new Error(`lock ${lockPath} cannot be created: ${errorText(e)}`, { cause: e });
  }
  try {
    await handle.writeFile(JSON.stringify({ token, pid: process.pid }), 'utf8');
    await handle.close();
  } catch (e) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw new Error(`lock ${lockPath} cannot be written: ${errorText(e)}`, { cause: e });
  }
  return true;
}

/** Remove the lock if it is still ours; a lock broken as stale and taken by another writer is left alone. */
async function unlock(lockPath: string, token: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(lockPath, 'utf8');
  } catch (e) {
    if (errorCode(e) === 'ENOENT') return;
    throw new Error(`lock ${lockPath} cannot be read: ${errorText(e)}`, { cause: e });
  }
  if (lockToken(content) === token) await unlink(lockPath);
}

/** Break a lock older than staleMs. True means: try to lock again now. */
async function breakStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  let seen;
  try {
    seen = await stat(lockPath);
  } catch (e) {
    if (errorCode(e) === 'ENOENT') return true;
    throw new Error(`lock ${lockPath} cannot be read: ${errorText(e)}`, { cause: e });
  }
  if (Date.now() - seen.mtimeMs < staleMs) return false;
  const aside = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, aside);
  } catch (e) {
    if (errorCode(e) === 'ENOENT') return true;
    throw new Error(`lock ${lockPath} cannot be broken: ${errorText(e)}`, { cause: e });
  }
  const moved = await stat(aside);
  if (moved.ino === seen.ino && moved.mtimeMs === seen.mtimeMs) {
    await unlink(aside);
    return true;
  }
  // Another writer took the lock between the check and the move: put its lock back.
  try {
    await link(aside, lockPath);
  } catch (e) {
    await unlink(aside).catch(() => undefined);
    throw new Error(`lock ${lockPath} changed hands while a stale lock was broken; try again`, { cause: e });
  }
  await unlink(aside);
  return false;
}

/** Run `work` while holding the lock file at `lockPath`. */
export async function withFileLock<T>(lockPath: string, work: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryLock(lockPath, token)) break;
    if (await breakStaleLock(lockPath, staleMs)) continue;
    if (Date.now() >= deadline) throw new Error(`lock ${lockPath} is held by another writer; try again`);
    await pause(2 + Math.floor(Math.random() * 10));
  }
  let result: T;
  try {
    result = await work();
  } catch (e) {
    await unlock(lockPath, token).catch(() => undefined);
    throw e;
  }
  await unlock(lockPath, token);
  return result;
}

/** Flush a directory entry (a created or linked file) to the device; best effort where the platform refuses. */
async function syncDir(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // Some filesystems refuse fsync on a directory; the file itself is synced.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Append one complete line and flush it to the device before returning. Errors propagate: nothing is silently lost. */
export async function appendDurable(file: string, line: string): Promise<void> {
  if (!line.endsWith('\n')) throw new Error('appendDurable: a line must end with a newline');
  const data = Buffer.from(line, 'utf8');
  const handle = await open(file, 'a');
  try {
    const { bytesWritten } = await handle.write(data, 0, data.length);
    if (bytesWritten !== data.length) throw new Error(`short write to ${file}: ${bytesWritten} of ${data.length} bytes`);
    await handle.datasync();
  } finally {
    await handle.close();
  }
}

/**
 * Create `file` with `content`, complete or not at all: the content is written and synced under a temporary name and
 * then linked into place, which fails if the file exists. Returns false when another writer created it first.
 */
export async function createExclusive(file: string, content: string): Promise<boolean> {
  const tmp = `${file}.tmp-${randomUUID()}`;
  const handle = await open(tmp, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tmp, file);
    await syncDir(path.dirname(file));
    return true;
  } catch (e) {
    if (errorCode(e) === 'EEXIST') return false;
    throw e;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

// One writer at a time across processes: the service, the CLI and the forced command all
// change the same state file. Every change is a short synchronous read-modify-write, so
// the lock is held for milliseconds.
//
// The lock file holds "<pid> <token> <created ms>". Only the process with the token
// removes it. A lock is stale when its process is gone, or when it is older than HUNG_MS
// (a process stuck while holding it), or when it is empty and older than STALE_MS (a
// process that died between creating and writing it). Taking a stale lock over, and
// releasing one's own, both go through an atomic rename to a private name and a check of
// what was moved: if it is not the lock that was judged, it is put back.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

const STALE_MS = 10_000;
const HUNG_MS = 60_000;
const WAIT_MS = 5_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number) => Atomics.wait(sleeper, 0, 0, ms);

export class LockTimeoutError extends Error {}

const read = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStale(file: string, content: string, now: number): boolean {
  const m = /^(\d+) [0-9a-f]{32} (\d+)$/.exec(content);
  if (!m) {
    try {
      return now - statSync(file).mtimeMs > STALE_MS;
    } catch {
      return false;
    }
  }
  return !alive(Number(m[1])) || now - Number(m[2]) > HUNG_MS;
}

/**
 * Moves the lock aside if it still holds `seen`. Returns true when it removed exactly that
 * lock; if the file held something else by then, that is put back and false is returned.
 */
export function breakStale(file: string, seen: string): boolean {
  const aside = `${file}.${randomBytes(8).toString("hex")}.aside`;
  try {
    renameSync(file, aside);
  } catch {
    return false;
  }
  const moved = read(aside);
  if (moved === seen) {
    rmSync(aside, { force: true });
    return true;
  }
  try {
    linkSync(aside, file);
  } catch {
    // A new lock exists already; the one moved aside cannot go back.
  }
  rmSync(aside, { force: true });
  return false;
}

/** Removes the lock only if it is still ours. */
function release(file: string, mine: string): void {
  if (read(file) !== mine) return;
  breakStale(file, mine);
}

export function withLock<T>(dir: string, fn: () => T): T {
  const file = join(dir, "state.lock");
  const deadline = Date.now() + WAIT_MS;
  const mine = `${process.pid} ${randomBytes(16).toString("hex")} ${Date.now()}`;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(file, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      try {
        return fn();
      } finally {
        release(file, mine);
      }
    }
    const held = read(file);
    if (held !== null && isStale(file, held, Date.now())) {
      breakStale(file, held);
      continue;
    }
    if (Date.now() > deadline)
      throw new LockTimeoutError(`could not lock ${file}`);
    sleep(5 + Math.floor(Math.random() * 10));
  }
}

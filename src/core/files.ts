// Private files: directories 0700, files 0600, written whole (temporary file, then rename),
// and read only when they are plain files of this account that nobody else can read.

import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
  chmodSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export class UnsafeFileError extends Error {}
/** The new content is in place, but the directory could not be synced: it may not survive a crash. */
export class CommitUnknownError extends Error {}

const uid = () =>
  typeof process.getuid === "function" ? process.getuid() : undefined;

/** Creates the directory (0700) or tightens an existing one to 0700. Refuses a symlink. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory())
    throw new UnsafeFileError(
      `${dir} is not a directory (a symlink is refused)`,
    );
  const me = uid();
  if (me !== undefined && st.uid !== me)
    throw new UnsafeFileError(`${dir} belongs to another user`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

/** The content, or null when the file does not exist. Throws if it is not private. */
export function readPrivate(file: string): string | null {
  let st;
  try {
    st = lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!st.isFile())
    throw new UnsafeFileError(
      `${file} is not a plain file (a symlink is refused)`,
    );
  const me = uid();
  if (me !== undefined && st.uid !== me)
    throw new UnsafeFileError(`${file} belongs to another user`);
  if (st.mode & 0o077)
    throw new UnsafeFileError(
      `${file} can be read by other users; run chmod 600 on it`,
    );
  return readFileSync(file, "utf8");
}

/**
 * Writes the file whole, 0600. A failure before the rename leaves the old content and
 * throws the error as it is; a failure after it (the directory sync) throws
 * CommitUnknownError, as the new content is in place but may not survive a crash.
 */
export function writePrivate(file: string, content: string): void {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  try {
    const dfd = openSync(dirname(file), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch (err) {
    throw new CommitUnknownError(
      `${file} was written but not synced: ${(err as Error).message}`,
    );
  }
}

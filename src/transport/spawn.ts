// One exchange through a child process: the JSON envelope goes to its stdin, one JSON
// answer comes back on its stdout. ssh is one such process; a local command (for tests
// and for wrapping ssh in another tool) is another. No shell is involved.

import { spawn } from "node:child_process";
import { BODY_BYTES, TRANSPORT_TIMEOUT_MS } from "../core/limits.ts";

export class TransportError extends Error {}

export interface SpawnOptions {
  timeoutMs?: number;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export function spawnJson(
  program: string,
  args: string[],
  payload: unknown,
  {
    timeoutMs = TRANSPORT_TIMEOUT_MS,
    maxBytes = BODY_BYTES,
    env,
  }: SpawnOptions = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > maxBytes) {
      reject(new TransportError("request too large"));
      return;
    }
    const child = spawn(program, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      ...(env ? { env } : {}),
    });
    const parts: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (err: Error | null, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new TransportError("timed out")),
      timeoutMs,
    );
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > maxBytes)
        return finish(new TransportError("answer too large"));
      parts.push(d);
    });
    // stderr is drained and dropped: it may hold host names or paths.
    child.stderr.on("data", () => {});
    child.on("error", (e: NodeJS.ErrnoException) =>
      finish(
        new TransportError(`could not start ${program}: ${e.code ?? "error"}`),
      ),
    );
    child.on("close", (code) => {
      if (done) return;
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(parts).toString("utf8"));
      } catch {
        return finish(
          new TransportError(
            code ? `exited with ${code}` : "unreadable answer",
          ),
        );
      }
      if (value && typeof value === "object" && "error" in value)
        return finish(new TransportError("the other machine could not answer"));
      finish(null, value);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(body);
  });
}

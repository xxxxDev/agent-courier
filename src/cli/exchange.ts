// `courier exchange --pair <id>`: the answering side, run only by the forced command of
// the other machine's dedicated SSH key, one key per pairing:
//   command="/abs/node /abs/agent-courier/bin/courier.js exchange --pair <id>",restrict ssh-ed25519 ...
// It reads one exchange (JSON, at most 256 KB, within 20 s) from stdin, answers it for
// that pairing only, from this machine's state under the lock, and writes the answer to
// stdout. It never reads SSH_ORIGINAL_COMMAND, so the key runs nothing else. Any failure
// prints one fixed line, never a path, a name or a reason, and writes no state.

import type { Readable, Writable } from "node:stream";
import { answer } from "../core/exchange.ts";
import { UUID } from "../core/ids.ts";
import { BODY_BYTES, EXCHANGE_READ_MS } from "../core/limits.ts";
import type { Store } from "../core/state.ts";

export const FAILED = '{"error":"exchange failed"}\n';

function readAll(
  input: Readable,
  max: number,
  timeoutMs: number,
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      input.destroy();
      resolve(null);
    }, timeoutMs);
    timer.unref();
    input.on("data", (d: Buffer) => {
      size += d.length;
      if (size > max) {
        clearTimeout(timer);
        input.destroy();
        resolve(null);
        return;
      }
      parts.push(d);
    });
    input.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(parts));
    });
    input.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

class TooLarge extends Error {}

export interface ExchangeOptions {
  /** The pairing named by the key's forced command. */
  pairId: string;
  timeoutMs?: number;
  maxAnswer?: number;
}

export async function runExchange(
  store: Store,
  input: Readable,
  output: Writable,
  {
    pairId,
    timeoutMs = EXCHANGE_READ_MS,
    maxAnswer = BODY_BYTES,
  }: ExchangeOptions,
): Promise<number> {
  try {
    if (!UUID.test(pairId)) throw new Error("bad pair id");
    const raw = await readAll(input, BODY_BYTES, timeoutMs);
    if (raw === null) throw new Error("too large or too slow");
    const body: unknown = JSON.parse(raw.toString("utf8"));
    // The size is checked inside the update, so an answer that cannot go writes nothing.
    const text = store.update((s) => {
      const out = JSON.stringify(answer(s, body, store.now(), pairId));
      if (Buffer.byteLength(out) > maxAnswer) throw new TooLarge();
      return out;
    });
    output.write(`${text}\n`);
    return 0;
  } catch {
    output.write(FAILED);
    return 1;
  }
}

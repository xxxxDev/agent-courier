// Idempotency keys. A send with a key already used for the same request is not done
// again: the agent gets the earlier message_id. The same key for a different request is
// refused. Keys are kept for LEDGER_MS, per agent, in the state file, written in the same
// write as the message itself, so a key is recorded exactly when its message is queued.

import { createHash } from "node:crypto";
import { LEDGER_MS } from "./limits.ts";
import type { State } from "./state.ts";

/** The value with every object's keys sorted, so key order never changes a digest. */
export const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .toSorted()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;

export const fingerprint = (payload: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(payload)))
    .digest("hex");

export type Seen =
  | { kind: "new" }
  | { kind: "repeat"; messageId: string }
  | { kind: "conflict" };

export function peekKey(
  s: State,
  agent: string,
  key: string,
  payload: unknown,
  now: number,
): Seen {
  const e = s.ledger.find(
    (x) => x.agent === agent && x.key === key && x.at > now - LEDGER_MS,
  );
  if (!e) return { kind: "new" };
  return e.fingerprint === fingerprint(payload)
    ? { kind: "repeat", messageId: e.messageId }
    : { kind: "conflict" };
}

export function recordKey(
  s: State,
  agent: string,
  key: string,
  payload: unknown,
  messageId: string,
  now: number,
): void {
  s.ledger.push({
    agent,
    key,
    fingerprint: fingerprint(payload),
    messageId,
    at: now,
  });
}

export function pruneLedger(s: State, now: number): void {
  s.ledger = s.ledger.filter((e) => e.at > now - LEDGER_MS);
}

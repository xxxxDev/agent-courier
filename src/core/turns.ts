// The loop stop. Two agents may write back and forth LOOP times; then they stop until a
// person approves a message between them. An approval (an answered elicitation, not
// auto-approve) restarts the count.

import { LOOP } from "./limits.ts";
import type { Agent, State } from "./state.ts";

export const turnKey = (pairId: string, remote: string) =>
  `${pairId}/${remote}`;

/** Messages between a local agent and one remote agent since a person last approved one. */
export function turns(
  s: State,
  a: Agent,
  pairId: string,
  remote: string,
): number {
  const since = a.approvedSeq[turnKey(pairId, remote)] ?? 0;
  const inbound = s.inbox.filter(
    (m) =>
      m.agent === a.name &&
      m.pairId === pairId &&
      m.from === remote &&
      m.seq >= since,
  ).length;
  const outbound = s.outbox.filter(
    (m) =>
      m.agent === a.name &&
      m.pairId === pairId &&
      m.to === remote &&
      (m.status === "queued" ||
        m.status === "in-flight" ||
        m.status === "delivered") &&
      m.seq >= since,
  ).length;
  return inbound + outbound;
}

export const loopReached = (
  s: State,
  a: Agent,
  pairId: string,
  remote: string,
) => turns(s, a, pairId, remote) >= LOOP;

/** A person approved this message between the two: the count starts again from it. */
export function markApproved(
  a: Agent,
  pairId: string,
  remote: string,
  seq: number,
): void {
  a.approvedSeq[turnKey(pairId, remote)] = seq;
}

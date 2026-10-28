// Who may talk to whom. Each side lists, per local agent, the agents of a paired machine
// it may write to and hear from. A message needs both lists: the sender's, checked when it
// is queued and again before it leaves, and the receiver's, which is the real gate since
// it is the one the sending machine cannot change.

import { conflict, invalid, limit, notFound } from "./errors.ts";
import { AGENT_NAME } from "./ids.ts";
import { MAX_ALLOW } from "./limits.ts";
import { findAgent } from "./agents.ts";
import { findPair } from "./pairing.ts";
import type { Agent, DirectoryEntry, State } from "./state.ts";

/** Parses `machine/agent`. */
export function parseTarget(target: string): {
  machine: string;
  agent: string;
} {
  const m = /^([^/]+)\/([^/]+)$/.exec(target);
  if (!m || !AGENT_NAME.test(m[2]!))
    throw invalid(
      "name the other agent as machine/agent, such as machine-b/helper",
    );
  return { machine: m[1]!, agent: m[2]! };
}

export const allows = (
  a: Agent | undefined,
  pairId: string,
  remote: string,
): boolean =>
  !!a && a.allow.some((x) => x.pairId === pairId && x.agent === remote);

export function allow(s: State, local: string, target: string): void {
  const a = findAgent(s, local);
  const { machine, agent } = parseTarget(target);
  const p = findPair(s, machine);
  if (allows(a, p.pairId, agent))
    throw conflict(`${local} already allows ${target}`);
  if (a.allow.length >= MAX_ALLOW)
    throw limit(`at most ${MAX_ALLOW} allowed agents per agent`, false);
  a.allow.push({ pairId: p.pairId, agent });
}

/** Takes it back. What the agent queued for that agent is settled when it would leave. */
export function disallow(s: State, local: string, target: string): void {
  const a = findAgent(s, local);
  const { machine, agent } = parseTarget(target);
  const p = findPair(s, machine);
  if (!allows(a, p.pairId, agent))
    throw notFound(`${local} does not allow ${target}`);
  a.allow = a.allow.filter(
    (x) => !(x.pairId === p.pairId && x.agent === agent),
  );
}

/** What the other machine is told: this machine's agents open to the pairing, and whom. */
export function directoryFor(s: State, pairId: string): DirectoryEntry[] {
  return s.agents
    .map((a) => ({
      agent: a.name,
      allows: a.allow.filter((x) => x.pairId === pairId).map((x) => x.agent),
    }))
    .filter((d) => d.allows.length > 0);
}

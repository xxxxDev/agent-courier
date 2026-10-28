// Local agents. An agent is a bearer token: whoever presents it to the MCP endpoint is
// that agent. The token is printed once; only its sha256 is kept.

import { timingSafeEqual } from "node:crypto";
import { conflict, invalid, limit, notFound } from "./errors.ts";
import { AGENT_NAME, TOKEN, newToken, sha256 } from "./ids.ts";
import { MAX_AGENTS } from "./limits.ts";
import type { Agent, State } from "./state.ts";
import { abandon } from "./outbox.ts";

export function checkAgentName(name: string): string {
  if (!AGENT_NAME.test(name))
    throw invalid(
      "an agent name is 1 to 32 lowercase letters, digits or inner hyphens, such as helper",
    );
  return name;
}

export function findAgent(s: State, name: string): Agent {
  const a = s.agents.find((x) => x.name === name);
  if (!a) throw notFound(`no agent named ${name}`);
  return a;
}

/** Adds an agent and returns its token, which is not kept and cannot be shown again. */
export function addAgent(s: State, name: string, now: number): string {
  checkAgentName(name);
  if (s.agents.some((a) => a.name === name))
    throw conflict(
      `an agent named ${name} exists; remove it first to make a new token`,
    );
  if (s.agents.length >= MAX_AGENTS)
    throw limit(`at most ${MAX_AGENTS} agents`, false);
  const token = newToken();
  s.agents.push({
    name,
    tokenHash: sha256(token),
    createdAt: new Date(now).toISOString(),
    autoApprove: false,
    allow: [],
    approvedSeq: {},
  });
  return token;
}

/** Removes the agent: its token stops working and what it queued is settled as unsent. */
export function removeAgent(s: State, name: string, now: number): void {
  findAgent(s, name);
  for (const m of s.outbox)
    if (m.agent === name && m.status === "queued")
      abandon(m, "the agent was removed", now);
  s.agents = s.agents.filter((a) => a.name !== name);
  s.inbox = s.inbox.filter((m) => m.agent !== name);
  s.ledger = s.ledger.filter((e) => e.agent !== name);
}

export function setAutoApprove(s: State, name: string, on: boolean): Agent {
  const a = findAgent(s, name);
  a.autoApprove = on;
  return a;
}

/**
 * The agent a bearer token belongs to, or null. Every stored hash is compared in constant
 * time, so the time taken does not tell which agent, if any, came close.
 */
export function agentByToken(
  s: State,
  token: string | undefined,
): Agent | null {
  if (typeof token !== "string" || !TOKEN.test(token)) return null;
  const want = Buffer.from(sha256(token), "hex");
  let found: Agent | null = null;
  for (const a of s.agents) {
    const have = Buffer.from(a.tokenHash, "hex");
    if (have.length === want.length && timingSafeEqual(have, want)) found = a;
  }
  return found;
}

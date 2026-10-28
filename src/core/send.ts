// The sending side's checks for peer_send and peer_reply. They run when the agent calls,
// and again after a person approves, since the pairing, the allow list or the limits may
// change while the person decides.

import { allows, parseTarget } from "./allow.ts";
import { conflict, denied, invalid, limit, notFound } from "./errors.ts";
import { HOURLY, LOOP, WAITING_OUT } from "./limits.ts";
import { expireOut } from "./outbox.ts";
import { flowing, pairById } from "./pairing.ts";
import { textProblem } from "./text.ts";
import { loopReached, markApproved } from "./turns.ts";
import { newId } from "./ids.ts";
import type { Agent, InMsg, OutMsg, Pair, State } from "./state.ts";

export interface Target {
  pair: Pair;
  remote: string;
}

const notAllowed = () =>
  denied(
    "not one of the agents you may write to: call peer_agents for the list",
  );

/** `machine/agent` as this agent may write to it. */
export function resolveTarget(s: State, a: Agent, to: string): Target {
  let parsed;
  try {
    parsed = parseTarget(to);
  } catch {
    throw notAllowed();
  }
  const pair = s.pairs.find((p) => p.name === parsed.machine);
  if (!pair || !allows(a, pair.pairId, parsed.agent)) throw notAllowed();
  return { pair, remote: parsed.agent };
}

/** The incoming message this agent answers, and where the answer goes. */
export function replyTarget(
  s: State,
  a: Agent,
  messageId: string,
): { msg: InMsg; target: Target } {
  const msg = s.inbox.find((m) => m.id === messageId && m.agent === a.name);
  if (!msg) throw notFound("no message with that message_id in your inbox");
  if (msg.kind !== "msg")
    throw invalid("that message is itself a reply; write again with peer_send");
  if (msg.answeredBy) throw conflict("you already answered that message");
  const pair = pairById(s, msg.pairId);
  if (!pair) throw conflict("the pairing that message came over is gone");
  if (!allows(a, pair.pairId, msg.from)) throw notAllowed();
  return { msg, target: { pair, remote: msg.from } };
}

/** Everything but the loop stop, which asks for a person instead of refusing. */
export function checkSend(
  s: State,
  a: Agent,
  t: Target,
  text: string,
  now: number,
): void {
  const problem = textProblem(text);
  if (problem) throw invalid(problem);
  if (!flowing(t.pair))
    throw conflict(
      `the pairing with ${t.pair.name} is not on at both ends now`,
    );
  expireOut(s, now);
  const hour = now - 3600_000;
  const sent = s.outbox.filter(
    (m) =>
      m.agent === a.name &&
      m.pairId === t.pair.pairId &&
      m.to === t.remote &&
      Date.parse(m.at) > hour,
  ).length;
  if (sent >= HOURLY)
    throw limit(`at most ${HOURLY} messages an hour to one agent`);
  const waiting = s.outbox.filter(
    (m) => m.agent === a.name && m.status === "queued",
  ).length;
  if (waiting >= WAITING_OUT)
    throw limit(
      `${WAITING_OUT} of your messages still wait to be taken; the other machine may be unreachable. Do not queue more; tell the user`,
    );
}

/** Whether this message needs a person: always, unless auto-approve is on and no loop stop. */
export const needsApproval = (s: State, a: Agent, t: Target): boolean =>
  !a.autoApprove || loopReached(s, a, t.pair.pairId, t.remote);

export const loopMessage = () =>
  `you and that agent have written ${LOOP} times without a person approving a message`;

export function queueOut(
  s: State,
  a: Agent,
  t: Target,
  opts: { text: string; reply?: InMsg; approved: boolean },
  now: number,
): OutMsg {
  const m: OutMsg = {
    seq: s.nextSeq++,
    id: newId(),
    agent: a.name,
    pairId: t.pair.pairId,
    machine: t.pair.name,
    to: t.remote,
    kind: opts.reply ? "reply" : "msg",
    ...(opts.reply ? { replyTo: opts.reply.itemId } : {}),
    text: opts.text,
    at: new Date(now).toISOString(),
    status: "queued",
    approved: opts.approved,
  };
  s.outbox.push(m);
  if (opts.reply) opts.reply.answeredBy = m.id;
  if (opts.approved) markApproved(a, t.pair.pairId, t.remote, m.seq);
  return m;
}

export interface PeerView {
  to: string;
  machine: string;
  agent: string;
  /** The pairing is on at both ends. */
  flowing: boolean;
  /** The other machine says that agent allows this one. */
  mutual: boolean;
}

export function peerAgents(s: State, a: Agent): PeerView[] {
  const out: PeerView[] = [];
  for (const x of a.allow) {
    const p = pairById(s, x.pairId);
    if (!p) continue;
    out.push({
      to: `${p.name}/${x.agent}`,
      machine: p.name,
      agent: x.agent,
      flowing: flowing(p),
      mutual: p.directory.some(
        (d) => d.agent === x.agent && d.allows.includes(a.name),
      ),
    });
  }
  return out;
}

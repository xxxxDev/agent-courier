// What arrives for this machine's agents. Delivery checks this side's own rules, which
// the sending machine cannot change: the agent exists and allows the sender, the text
// fits, a reply answers a message of ours once, and the rate, waiting and loop limits.

import {
  HOURLY,
  INBOX_PAGE,
  KEEP_MS,
  KEEP_PER_AGENT,
  WAITING_IN,
} from "./limits.ts";
import { allows } from "./allow.ts";
import { newId } from "./ids.ts";
import type { RefusalCode } from "./reasons.ts";
import { textProblem } from "./text.ts";
import { loopReached } from "./turns.ts";
import type { WireItem } from "./outbox.ts";
import type { Agent, InMsg, Pair, State } from "./state.ts";

export type Delivery =
  { ok: true } | { ok: false; code: RefusalCode; retry?: boolean };

export const unread = (s: State, a: Agent): number =>
  s.inbox.filter((m) => m.agent === a.name && !m.read).length;

export function deliver(
  s: State,
  p: Pair,
  it: WireItem,
  now: number,
): Delivery {
  const a = s.agents.find((x) => x.name === it.to);
  if (!a || !allows(a, p.pairId, it.from))
    return { ok: false, code: "not-open" };
  const problem = textProblem(it.text);
  if (problem) return { ok: false, code: "bad-text" };
  let replyTo: string | undefined;
  if (it.kind === "reply") {
    // A reply answers something this agent sent that agent, once.
    const orig = s.outbox.find(
      (m) =>
        m.id === it.replyTo &&
        m.pairId === p.pairId &&
        m.agent === a.name &&
        m.to === it.from &&
        m.kind === "msg",
    );
    if (!orig) return { ok: false, code: "not-a-reply" };
    if (
      s.inbox.some(
        (m) =>
          m.agent === a.name && m.kind === "reply" && m.replyTo === orig.id,
      )
    )
      return { ok: false, code: "already-answered" };
    replyTo = orig.id;
  }
  const hour = now - 3600_000;
  const lastHour = s.inbox.filter(
    (m) =>
      m.agent === a.name &&
      m.pairId === p.pairId &&
      m.from === it.from &&
      Date.parse(m.at) > hour,
  ).length;
  if (lastHour >= HOURLY) return { ok: false, code: "hourly", retry: true };
  if (unread(s, a) >= WAITING_IN)
    return {
      ok: false,
      code: "unread",
      retry: true,
    };
  if (loopReached(s, a, p.pairId, it.from))
    return {
      ok: false,
      code: "loop",
      retry: true,
    };
  const m: InMsg = {
    seq: s.nextSeq++,
    id: newId(),
    itemId: it.id,
    agent: a.name,
    pairId: p.pairId,
    machine: p.name,
    from: it.from,
    kind: it.kind,
    ...(replyTo ? { replyTo } : {}),
    text: it.text,
    sentAt: it.at,
    at: new Date(now).toISOString(),
  };
  s.inbox.push(m);
  return { ok: true };
}

/** One page of the inbox after the cursor (default: what the agent has not been handed). */
export function readInbox(
  s: State,
  a: Agent,
  cursor: number | undefined,
): { messages: InMsg[]; cursor: number; more: boolean } {
  const mine = s.inbox.filter((m) => m.agent === a.name);
  // Without a cursor: what has not been handed out yet. With one: everything after it; a
  // cursor beyond the newest number reads nothing and skips nothing.
  const after =
    cursor === undefined ? undefined : Math.min(cursor, s.nextSeq - 1);
  const all = mine.filter((m) =>
    after === undefined ? !m.read : m.seq > after,
  );
  const messages = all.slice(0, INBOX_PAGE);
  // Only what is handed out now counts as read.
  for (const m of messages) m.read = true;
  const last =
    messages.at(-1)?.seq ?? after ?? Math.max(0, ...mine.map((m) => m.seq));
  return { messages, cursor: last, more: all.length > messages.length };
}

/** Read messages older than KEEP_MS go, and beyond KEEP_PER_AGENT per agent. Unread stay. */
export function pruneIn(s: State, now: number): void {
  const kept: InMsg[] = [];
  const count = new Map<string, number>();
  for (let i = s.inbox.length - 1; i >= 0; i--) {
    const m = s.inbox[i]!;
    const isUnread = !m.read && s.agents.some((x) => x.name === m.agent);
    const n = count.get(m.agent) ?? 0;
    if (!isUnread && (Date.parse(m.at) < now - KEEP_MS || n >= KEEP_PER_AGENT))
      continue;
    count.set(m.agent, n + 1);
    kept.push(m);
  }
  s.inbox = kept.toReversed();
}

// Pairing two machines. The answering side makes a one-time code (`courier pair`); the
// calling side sends it over its transport (`courier join`). Then each side enables the
// pairing on its own (`courier enable`); messages flow only while both have it on.

import { timingSafeEqual } from "node:crypto";
import { conflict, invalid, limit, notFound } from "./errors.ts";
import { MACHINE_NAME, UUID, codeKey, newCode, newId } from "./ids.ts";
import {
  INVITES_HOURLY,
  INVITE_MS,
  INVITE_TRIES,
  MAX_PAIRS,
} from "./limits.ts";
import { closePair } from "./outbox.ts";
import type { Pair, State, Transport } from "./state.ts";

export function checkMachineName(name: string): string {
  if (!MACHINE_NAME.test(name))
    throw invalid(
      "a machine name is 1 to 40 lowercase letters, digits, dots or hyphens, such as machine-b",
    );
  return name;
}

export function findPair(s: State, name: string): Pair {
  const p = s.pairs.find((x) => x.name === name);
  if (!p) throw notFound(`no paired machine named ${name}`);
  return p;
}

export const pairById = (s: State, pairId: string): Pair | undefined =>
  s.pairs.find((p) => p.pairId === pairId);

/** Messages flow only while this side has it on and the other side said so last time. */
export const flowing = (p: Pair | undefined): boolean =>
  !!p && p.state === "active" && p.remote.enabled && !p.remote.paused;

/** The answering side: a new code replaces any open one. Ten an hour. */
export function createInvite(
  s: State,
  name: string | null,
  now: number,
): { code: string; expiresAt: string; pairId: string } {
  if (name !== null) checkMachineName(name);
  s.inviteLog = s.inviteLog.filter((t) => t > now - 3600_000);
  if (s.inviteLog.length >= INVITES_HOURLY)
    throw limit("too many pairing codes this hour; try again later");
  const code = newCode();
  const pairId = newId();
  s.invites = [
    { pairId, key: codeKey(code), expires: now + INVITE_MS, tries: 0, name },
  ];
  s.inviteLog.push(now);
  return { code, expiresAt: new Date(now + INVITE_MS).toISOString(), pairId };
}

export const openInvite = (s: State, now: number) =>
  s.invites.find((x) => x.expires > now && x.tries < INVITE_TRIES) ?? null;

/** A label not used by another pairing: the wanted one, else with -2, -3... */
function freeLabel(s: State, want: string, remoteMachineId: string): string {
  const taken = (n: string) =>
    s.pairs.some((p) => p.name === n && p.remoteMachineId !== remoteMachineId);
  if (!taken(want)) return want;
  for (let i = 2; ; i++) {
    const n = `${want.slice(0, 36)}-${i}`;
    if (!taken(n)) return n;
  }
}

function blankPair(
  pairId: string,
  name: string,
  role: Pair["role"],
  remoteMachineId: string,
  remoteName: string,
  now: number,
): Pair {
  return {
    pairId,
    name,
    role,
    state: "linked",
    remoteMachineId,
    remoteName,
    remote: { enabled: false, paused: false },
    linkedAt: new Date(now).toISOString(),
    lastContact: null,
    lastError: null,
    directory: [],
    pendingAcks: [],
    pendingRefused: [],
  };
}

/** A machine paired again starts afresh: the old pairing and what waited for it are gone. */
function dropPairsWith(s: State, remoteMachineId: string, now: number): void {
  for (const p of s.pairs.filter((x) => x.remoteMachineId === remoteMachineId))
    revokePair(s, p, "paired again", now);
}

export type RedeemResult =
  | { ok: true; pairId: string; machineId: string; name: string }
  | { ok: false; reason: "no-open-code" | "wrong-code" | "bad-request" };

/** The answering side, on a pair request: a wrong code spends one of five tries. */
export function redeem(
  s: State,
  req: { code: string; machineId: string; name: string },
  now: number,
): RedeemResult {
  s.invites = s.invites.filter(
    (x) => x.expires > now && x.tries < INVITE_TRIES,
  );
  const inv = s.invites[0];
  if (!inv) return { ok: false, reason: "no-open-code" };
  const given = Buffer.from(codeKey(req.code), "hex");
  if (!timingSafeEqual(given, Buffer.from(inv.key, "hex"))) {
    inv.tries++;
    return { ok: false, reason: "wrong-code" };
  }
  if (!UUID.test(req.machineId) || req.machineId === s.machineId)
    return { ok: false, reason: "bad-request" };
  if (
    s.pairs.filter((p) => p.remoteMachineId !== req.machineId).length >=
    MAX_PAIRS
  )
    return { ok: false, reason: "bad-request" };
  s.invites = [];
  dropPairsWith(s, req.machineId, now);
  const want =
    inv.name ??
    (MACHINE_NAME.test(req.name)
      ? req.name
      : `peer-${req.machineId.slice(0, 8)}`);
  const p = blankPair(
    inv.pairId,
    freeLabel(s, want, req.machineId),
    "answerer",
    req.machineId,
    MACHINE_NAME.test(req.name) ? req.name : "",
    now,
  );
  s.pairs.push(p);
  return { ok: true, pairId: p.pairId, machineId: s.machineId, name: s.name };
}

/** The calling side, once the other machine took its code. */
export function addCallerPair(
  s: State,
  opts: {
    pairId: string;
    remoteMachineId: string;
    remoteName: string;
    name: string;
    transport: Transport;
  },
  now: number,
): Pair {
  checkMachineName(opts.name);
  if (!UUID.test(opts.pairId) || !UUID.test(opts.remoteMachineId))
    throw invalid("the other machine's answer is not in the expected format");
  if (opts.remoteMachineId === s.machineId)
    throw conflict("that is this machine");
  dropPairsWith(s, opts.remoteMachineId, now);
  if (s.pairs.some((p) => p.name === opts.name))
    throw conflict(
      `another pairing is named ${opts.name}; choose another --name`,
    );
  if (s.pairs.length >= MAX_PAIRS)
    throw limit(`at most ${MAX_PAIRS} pairings`, false);
  const p = blankPair(
    opts.pairId,
    opts.name,
    "caller",
    opts.remoteMachineId,
    MACHINE_NAME.test(opts.remoteName) ? opts.remoteName : "",
    now,
  );
  p.transport = opts.transport;
  s.pairs.push(p);
  return p;
}

export function enablePair(s: State, name: string): Pair {
  const p = findPair(s, name);
  p.state = "active";
  return p;
}

/** Pausing settles what waited for the pairing as unsent: a later enable sends no old words. */
export function pausePair(s: State, name: string, now: number): Pair {
  const p = findPair(s, name);
  if (p.state === "linked") throw conflict(`${name} is not enabled yet`);
  p.state = "paused";
  closePair(s, p.pairId, "the pairing was paused", now);
  return p;
}

export function revokePair(s: State, p: Pair, why: string, now: number): void {
  closePair(s, p.pairId, why, now);
  s.pairs = s.pairs.filter((x) => x.pairId !== p.pairId);
  for (const a of s.agents)
    a.allow = a.allow.filter((x) => x.pairId !== p.pairId);
  for (const k of Object.keys(s.seen))
    if (k.startsWith(`${p.pairId}:`)) delete s.seen[k];
}

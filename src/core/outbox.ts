// What this machine's agents sent: queued until the other side takes it, then delivered,
// refused, expired or unsent. Each exchange leases what it carries, so a lost answer
// sends it again; the other side drops repeats by id.

import { remoteReason } from "./reasons.ts";
import {
  BATCH_BYTES,
  EXPIRE_MS,
  ITEM_BYTES,
  KEEP_MS,
  KEEP_PER_AGENT,
  LEASE_MS,
} from "./limits.ts";
import { allows } from "./allow.ts";
import type { OutMsg, OutStatus, Refusal, State } from "./state.ts";

export interface WireItem {
  id: string;
  pairId: string;
  kind: "msg" | "reply";
  from: string;
  to: string;
  replyTo?: string;
  at: string;
  text: string;
}

export function settleOut(
  m: OutMsg,
  status: OutStatus,
  reason: string | null,
  now: number,
): void {
  m.status = status;
  m.resultAt = new Date(now).toISOString();
  delete m.leaseUntil;
  if (reason) m.reason = reason.slice(0, 200);
  else delete m.reason;
}

/** Queued for EXPIRE_MS and not out on a lease: it expires. */
export function expireOut(s: State, now: number): void {
  for (const m of s.outbox)
    if (
      m.status === "queued" &&
      !((m.leaseUntil ?? 0) > now) &&
      Date.parse(m.at) < now - EXPIRE_MS
    )
      settleOut(
        m,
        "expired",
        m.handed
          ? "not confirmed within 24 hours; it may have arrived"
          : "not taken within 24 hours",
        now,
      );
}

/**
 * A queued message that will not go any more. If it was never handed over, it is unsent.
 * If it was (it may be out right now, or its answer was lost), it is in flight: it will
 * not go again, but a later receipt still settles it.
 */
export function abandon(m: OutMsg, why: string, now: number): void {
  if (m.status !== "queued") return;
  if (m.handed) {
    m.status = "in-flight";
    m.reason = `${why} while it was on its way; it may have arrived`.slice(
      0,
      200,
    );
    m.resultAt = new Date(now).toISOString();
    delete m.leaseUntil;
  } else settleOut(m, "unsent", why, now);
}

/** The pairing paused or gone: what waited for it will not go. */
export function closePair(
  s: State,
  pairId: string,
  why: string,
  now: number,
): void {
  for (const m of s.outbox) if (m.pairId === pairId) abandon(m, why, now);
}

export const toWire = (m: OutMsg): WireItem => ({
  id: m.id,
  pairId: m.pairId,
  kind: m.kind,
  from: m.agent,
  to: m.to,
  ...(m.replyTo ? { replyTo: m.replyTo } : {}),
  at: m.at,
  text: m.text,
});

/**
 * What goes out now for this pairing, up to `budget` bytes, each leased for LEASE_MS. One
 * that may no longer go (the agent gone, the allow taken back) is abandoned.
 */
export function collect(
  s: State,
  pairId: string,
  now: number,
  budget = BATCH_BYTES,
): WireItem[] {
  expireOut(s, now);
  const items: WireItem[] = [];
  let bytes = 2;
  for (const m of s.outbox) {
    if (
      m.pairId !== pairId ||
      m.status !== "queued" ||
      (m.leaseUntil ?? 0) > now
    )
      continue;
    const a = s.agents.find((x) => x.name === m.agent);
    if (!allows(a, pairId, m.to)) {
      abandon(m, "the agent was closed to that agent", now);
      continue;
    }
    const it = toWire(m);
    const size = Buffer.byteLength(JSON.stringify(it)) + 1;
    if (size > ITEM_BYTES) {
      settleOut(m, "refused", "too large to send", now);
      continue;
    }
    if (bytes + size > budget) continue;
    bytes += size;
    m.leaseUntil = now + LEASE_MS;
    m.handed = true;
    items.push(it);
  }
  return items;
}

export type Settled = { id: string; ok: true } | ({ ok: false } & Refusal);

/** The other side's receipts: delivered, refused for good, or refused for now (stays queued). */
export function settleReceipts(
  s: State,
  pairId: string,
  list: Settled[],
  now: number,
): void {
  for (const r of list) {
    const m = s.outbox.find((x) => x.id === r.id && x.pairId === pairId);
    if (!m || (m.status !== "queued" && m.status !== "in-flight")) continue;
    if (r.ok) settleOut(m, "delivered", null, now);
    else if (r.retry) {
      if (m.status === "in-flight") continue;
      delete m.leaseUntil;
      m.reason = remoteReason(r.code);
    } else settleOut(m, "refused", remoteReason(r.code), now);
  }
}

/** The exchange failed: what it carried may go again at once. */
export function release(s: State, pairId: string, ids: string[]): void {
  for (const id of ids) {
    const m = s.outbox.find((x) => x.id === id && x.pairId === pairId);
    if (m?.status === "queued") delete m.leaseUntil;
  }
}

export interface OutView {
  message_id: string;
  to: string;
  kind: "msg" | "reply";
  status: OutStatus;
  reason?: string;
  at: string;
  result_at?: string;
}

export const outView = (m: OutMsg): OutView => ({
  message_id: m.id,
  to: `${m.machine}/${m.to}`,
  kind: m.kind,
  status: m.status,
  ...(m.reason ? { reason: m.reason } : {}),
  at: m.at,
  ...(m.resultAt ? { result_at: m.resultAt } : {}),
});

/** Settled messages older than KEEP_MS go, and beyond KEEP_PER_AGENT per agent. */
export function pruneOut(s: State, now: number): void {
  const kept: OutMsg[] = [];
  const count = new Map<string, number>();
  for (let i = s.outbox.length - 1; i >= 0; i--) {
    const m = s.outbox[i]!;
    const n = count.get(m.agent) ?? 0;
    const old = Date.parse(m.resultAt ?? m.at) < now - KEEP_MS;
    if (m.status !== "queued" && (old || n >= KEEP_PER_AGENT)) continue;
    count.set(m.agent, n + 1);
    kept.push(m);
  }
  s.outbox = kept.toReversed();
}

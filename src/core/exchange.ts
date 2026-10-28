// One exchange: the caller sends its envelope (its state, directory, items and receipts),
// the answerer takes it and answers with its own. Both sides run receive() on what they
// get. These functions change the state and run inside Store.update; the transport call
// itself happens outside the lock (caller.ts).

import { directoryFor } from "./allow.ts";
import { deliver, pruneIn } from "./inbox.ts";
import {
  BATCH_BYTES,
  FUTURE_MS,
  ITEM_BYTES,
  OLD_MS,
  SEEN_MS,
} from "./limits.ts";
import { MACHINE_NAME, UUID } from "./ids.ts";
import {
  closePair,
  collect,
  pruneOut,
  release,
  settleReceipts,
  type Settled,
  type WireItem,
} from "./outbox.ts";
import { flowing, pairById, redeem } from "./pairing.ts";
import type { Pair, Refusal, State } from "./state.ts";
import {
  DirectoryEntry,
  Envelope,
  Item,
  PairRequest,
  UnknownPair,
  V,
} from "./wire.ts";
import { pruneLedger } from "./ledger.ts";
import type { RefusalCode } from "./reasons.ts";

export class ExchangeError extends Error {}

export function envelopeFor(
  s: State,
  p: Pair,
  extra: { items: WireItem[]; acks: string[]; refused: Refusal[] },
): Envelope {
  return {
    v: V,
    pairId: p.pairId,
    from: { machineId: s.machineId, name: s.name },
    state: { enabled: p.state === "active", paused: p.state === "paused" },
    directory: directoryFor(s, p.pairId),
    ...extra,
  };
}

/** What one side takes from the other's envelope; returns its receipts for the items. */
export function receive(
  s: State,
  p: Pair,
  env: Envelope,
  now: number,
): { acks: string[]; refused: Refusal[] } {
  p.remote = { enabled: env.state.enabled, paused: env.state.paused };
  p.remoteName = MACHINE_NAME.test(env.from.name) ? env.from.name : "";
  p.directory = env.directory.flatMap((d) => {
    const r = DirectoryEntry.safeParse(d);
    return r.success ? [r.data] : [];
  });
  const settled: Settled[] = [
    ...env.acks.map((id) => ({ id, ok: true as const })),
    ...env.refused.map((r) => ({
      id: r.id,
      code: r.code,
      ...(r.retry ? { retry: true } : {}),
      ok: false as const,
    })),
  ];
  settleReceipts(s, p.pairId, settled, now);

  for (const [k, at] of Object.entries(s.seen))
    if (at < now - SEEN_MS) delete s.seen[k];
  const acks: string[] = [];
  const refused: Refusal[] = [];
  for (const raw of env.items) {
    const rawId = (raw as { id?: unknown } | null)?.id;
    const id = typeof rawId === "string" && UUID.test(rawId) ? rawId : null;
    if (!id) continue;
    const no = (code: RefusalCode, retry = false) =>
      refused.push({ id, code, ...(retry ? { retry: true } : {}) });
    const key = `${p.pairId}:${id}`;
    if (s.seen[key]) {
      acks.push(id);
      continue;
    }
    if (Buffer.byteLength(JSON.stringify(raw)) > ITEM_BYTES) {
      no("too-large");
      continue;
    }
    const parsed = Item.safeParse(raw);
    if (!parsed.success) {
      no("format");
      continue;
    }
    const it = parsed.data as WireItem;
    if (it.pairId !== p.pairId) {
      no("wrong-pairing");
      continue;
    }
    if (!flowing(p)) {
      no("not-on", true);
      continue;
    }
    const at = Date.parse(it.at);
    if (!Number.isFinite(at) || at > now + FUTURE_MS || at < now - OLD_MS) {
      no("too-old");
      continue;
    }
    const r = deliver(s, p, it, now);
    if (r.ok) {
      s.seen[key] = now;
      acks.push(id);
    } else no(r.code, r.retry === true);
  }
  p.lastContact = new Date(now).toISOString();
  p.lastError = null;
  pruneIn(s, now);
  pruneOut(s, now);
  pruneLedger(s, now);
  return { acks, refused };
}

/**
 * The answering side: one call from the caller, answered from this machine's state.
 * `bound` is the pairing named by the forced command of the key that called
 * (`courier exchange --pair <id>`): the key may make that pairing and exchange for it,
 * nothing else. Another paired machine that knows this pairing's ids cannot use it.
 */
export function answer(
  s: State,
  body: unknown,
  now: number,
  bound: string,
): unknown {
  if (body && typeof body === "object" && "pair" in body) {
    const req = PairRequest.safeParse(body);
    if (!req.success) throw new ExchangeError("bad pair request");
    if (s.invites[0]?.pairId !== bound)
      throw new ExchangeError("no open code for this key");
    return { v: V, pair: redeem(s, req.data.pair, now) };
  }
  const parsed = Envelope.safeParse(body);
  if (!parsed.success) throw new ExchangeError("bad envelope");
  const env = parsed.data;
  if (env.pairId !== bound) throw new ExchangeError("another pairing's key");
  const p = pairById(s, env.pairId);
  if (!p || p.role !== "answerer" || p.remoteMachineId !== env.from.machineId)
    return { v: V, unknownPair: true };
  const receipts = receive(s, p, env, now);
  return withItems(s, p, envelopeFor(s, p, { items: [], ...receipts }), now);
}

/** The calling side, before its call: the envelope and the ids it carries. */
export function prepareCall(
  s: State,
  p: Pair,
  now: number,
): { payload: Envelope; sent: string[]; fresh: string[] } {
  const handedBefore = new Set(
    s.outbox.filter((m) => m.pairId === p.pairId && m.handed).map((m) => m.id),
  );
  const payload = withItems(
    s,
    p,
    envelopeFor(s, p, {
      items: [],
      acks: p.pendingAcks,
      refused: p.pendingRefused,
    }),
    now,
  );
  const sent = payload.items.map((x) => (x as WireItem).id);
  return { payload, sent, fresh: sent.filter((id) => !handedBefore.has(id)) };
}

/**
 * Fills an envelope with queued items while the pairing flows, so that the whole
 * envelope (directory, acks and refusals included) stays within BATCH_BYTES.
 */
function withItems(s: State, p: Pair, env: Envelope, now: number): Envelope {
  if (!flowing(p)) return env;
  const budget = BATCH_BYTES - Buffer.byteLength(JSON.stringify(env));
  return { ...env, items: budget > 0 ? collect(s, p.pairId, now, budget) : [] };
}

/**
 * The calling side, with the answer. "gone" when the other machine no longer has the
 * pairing: what waits for it will not go. Throws ExchangeError on an answer that does
 * not fit, and the call counts as failed.
 */
export function finishCall(
  s: State,
  pairId: string,
  answerBody: unknown,
  now: number,
  fresh: string[] = [],
): "ok" | "gone" | "removed" {
  const p = pairById(s, pairId);
  if (!p) return "removed";
  if (UnknownPair.safeParse(answerBody).success) {
    // What went for the first time in this very call did not arrive: the other machine
    // answered without taking anything.
    for (const m of s.outbox)
      if (m.pairId === pairId && fresh.includes(m.id)) m.handed = false;
    closePair(s, pairId, "the other machine no longer has this pairing", now);
    p.remote = { enabled: false, paused: false };
    p.lastError = "the other machine no longer has this pairing: pair again";
    return "gone";
  }
  const parsed = Envelope.safeParse(answerBody);
  if (
    !parsed.success ||
    parsed.data.pairId !== p.pairId ||
    parsed.data.from.machineId !== p.remoteMachineId
  )
    throw new ExchangeError("unexpected answer");
  const { acks, refused } = receive(s, p, parsed.data, now);
  // Its receipts for what we sent came back now; ours for what it sent go next time.
  p.pendingAcks = acks;
  p.pendingRefused = refused;
  return "ok";
}

/** The call failed: what it carried may go again, and the error is shown in status. */
export function failCall(
  s: State,
  pairId: string,
  sent: string[],
  error: string,
): void {
  const p = pairById(s, pairId);
  if (!p) return;
  release(s, pairId, sent);
  p.lastError = error.slice(0, 200);
}

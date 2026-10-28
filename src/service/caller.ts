// The calling side's loop: for each pairing this machine calls, one exchange every 15 to
// 20 s, sooner when an agent queued something, backing off up to 5 min while it fails.
// The state is locked to prepare the call and to take the answer, never across the call.

import {
  failCall,
  finishCall,
  prepareCall,
  ExchangeError,
} from "../core/exchange.ts";
import { BACKOFF_MAX_MS, POLL_MS } from "../core/limits.ts";
import type { Store, Transport } from "../core/state.ts";
import type { Call } from "../transport/index.ts";

export type CallFor = (t: Transport) => Call;

/** One exchange with each calling pairing. Returns how many failed. */
export async function callerRound(
  store: Store,
  callFor: CallFor,
  log: (l: string) => void,
): Promise<number> {
  let failures = 0;
  const ids = store
    .read()
    .pairs.filter((p) => p.role === "caller" && p.transport)
    .map((p) => p.pairId);
  for (const pairId of ids) {
    const prepared = store.update((s) => {
      const p = s.pairs.find((x) => x.pairId === pairId);
      if (!p?.transport) return null;
      return {
        ...prepareCall(s, p, store.now()),
        transport: p.transport,
        name: p.name,
      };
    });
    if (!prepared) continue;
    try {
      const answer = await callFor(prepared.transport)(prepared.payload);
      const r = store.update((s) =>
        finishCall(s, pairId, answer, store.now(), prepared.fresh),
      );
      if (r === "gone")
        log(`${prepared.name}: the other machine no longer has this pairing`);
    } catch (err) {
      failures++;
      const message =
        err instanceof ExchangeError
          ? err.message
          : String((err as Error).message ?? err);
      store.update((s) => failCall(s, pairId, prepared.sent, message));
      log(`${prepared.name}: exchange failed: ${message}`);
    }
  }
  return failures;
}

export class CallerLoop {
  readonly #store: Store;
  readonly #callFor: CallFor;
  readonly #log: (l: string) => void;
  readonly #poll: readonly [number, number];
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #again = false;
  #failures = 0;
  #stopped = false;
  #idle: Promise<void> = Promise.resolve();

  constructor(
    store: Store,
    callFor: CallFor,
    log: (l: string) => void,
    poll: readonly [number, number] = POLL_MS,
  ) {
    this.#store = store;
    this.#callFor = callFor;
    this.#log = log;
    this.#poll = poll;
  }

  start(): void {
    this.#schedule(Math.min(3000, this.#poll[0]));
  }

  /** Something to send: two seconds to gather more, then an exchange. */
  kick(): void {
    if (this.#stopped) return;
    if (this.#running) this.#again = true;
    else this.#schedule(Math.min(2000, this.#poll[0]));
  }

  /** Stops the loop; resolves once a round in progress has finished. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#idle;
  }

  #schedule(ms: number): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#tick(), ms);
    this.#timer.unref();
  }

  async #tick(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    const idle = Promise.withResolvers<void>();
    this.#idle = idle.promise;
    try {
      const failed = await callerRound(this.#store, this.#callFor, this.#log);
      this.#failures = failed ? this.#failures + 1 : 0;
    } catch (err) {
      this.#failures++;
      this.#log(`exchange round failed: ${(err as Error).message}`);
    } finally {
      this.#running = false;
      idle.resolve();
    }
    const [lo, hi] = this.#poll;
    const base = lo + Math.floor(Math.random() * (hi - lo));
    const next = this.#again
      ? Math.min(2000, lo)
      : this.#failures
        ? Math.min(BACKOFF_MAX_MS, base * 2 ** Math.min(this.#failures, 4))
        : base;
    this.#again = false;
    this.#schedule(next);
  }
}

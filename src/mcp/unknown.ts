// Idempotency keys whose send has an unknown outcome: the write was in place but could
// not be confirmed durable. Such a key is locked for a day and the agent is told not to
// send again. In memory, as the state file is what could not be relied on.

import { LEDGER_MS } from "../core/limits.ts";

export class UnknownKeys {
  readonly #until = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  add(agent: string, key: string): void {
    this.#until.set(`${agent}\n${key}`, this.#now() + LEDGER_MS);
  }

  has(agent: string, key: string): boolean {
    const id = `${agent}\n${key}`;
    const until = this.#until.get(id);
    if (until === undefined) return false;
    if (until > this.#now()) return true;
    this.#until.delete(id);
    return false;
  }
}

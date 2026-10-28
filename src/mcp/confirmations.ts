// Open approvals. Under MCP 2026-07-28 a call that needs the person answers with
// input_required; the client asks (elicitation) and calls again with the answer and the
// requestState it was given. That state is only a random nonce: what it stands for (the
// agent, the tool, the exact arguments, the deadline) stays here, so a client can neither
// forge nor alter it, and each nonce answers once. In memory only.

import { createHash, randomBytes } from "node:crypto";
import { canonical } from "../core/ledger.ts";
import { CONFIRM_PER_AGENT, CONFIRM_TTL_MS } from "../core/limits.ts";

export type Taken = "ok" | "unknown" | "expired" | "mismatch";

/** What an approval covers: the agent, the tool and its exact arguments. */
export const digestOf = (agent: string, tool: string, args: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify([agent, tool, canonical(args)]))
    .digest("hex");

export class Confirmations {
  readonly ttlMs: number;
  readonly #perAgent: number;
  readonly #now: () => number;
  readonly #open = new Map<
    string,
    { agent: string; digest: string; until: number; bound: string | undefined }
  >();

  constructor({
    ttlMs = CONFIRM_TTL_MS,
    perAgent = CONFIRM_PER_AGENT,
    now = Date.now,
  }: { ttlMs?: number; perAgent?: number; now?: () => number } = {}) {
    this.ttlMs = ttlMs;
    this.#perAgent = perAgent;
    this.#now = now;
  }

  #prune(): void {
    const now = this.#now();
    for (const [nonce, c] of this.#open)
      if (c.until <= now) this.#open.delete(nonce);
  }

  /**
   * A new question's nonce, or undefined when this agent already has perAgent questions
   * open. A full agent is refused rather than pushing out a question the person may be
   * reading, and one agent cannot use up the questions of the others.
   */
  issue(agent: string, digest: string, bound?: string): string | undefined {
    this.#prune();
    let open = 0;
    for (const c of this.#open.values()) if (c.agent === agent) open++;
    if (open >= this.#perAgent) return undefined;
    const nonce = randomBytes(16).toString("hex");
    this.#open.set(nonce, {
      agent,
      digest,
      until: this.#now() + this.ttlMs,
      bound,
    });
    return nonce;
  }

  /** Spends the nonce, whatever the outcome, and says whether it covers this call. */
  take(nonce: string, digest: string): Taken {
    return this.takeBound(nonce, digest).taken;
  }

  /**
   * take(), plus what was bound to the question when it was asked (what the person was
   * shown that the call must still match, such as the pairing a label stood for).
   */
  takeBound(nonce: string, digest: string): { taken: Taken; bound?: string } {
    const c = this.#open.get(nonce);
    if (!c) return { taken: "unknown" };
    this.#open.delete(nonce);
    if (this.#now() >= c.until) return { taken: "expired" };
    if (c.digest !== digest) return { taken: "mismatch" };
    return c.bound === undefined
      ? { taken: "ok" }
      : { taken: "ok", bound: c.bound };
  }
}

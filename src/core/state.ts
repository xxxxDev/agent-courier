// The state of one machine, in one private file (<data dir>/state.json, 0600). The
// service, the CLI and the forced command each load it, change it under the lock and write
// it whole; nothing is kept only in a process except open approvals and unknown outcomes.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  CommitUnknownError,
  ensurePrivateDir,
  readPrivate,
  writePrivate,
} from "./files.ts";
import { MACHINE_NAME, UUID, newId } from "./ids.ts";
import { DEFAULT_PORT } from "./limits.ts";
import { withLock } from "./lock.ts";

export interface Allow {
  pairId: string;
  agent: string;
}

export interface Agent {
  name: string;
  /** sha256 of the token; the token itself is shown once and never stored. */
  tokenHash: string;
  createdAt: string;
  autoApprove: boolean;
  /** Agents of paired machines this one may write to and hear from. */
  allow: Allow[];
  /** `<pairId>/<agent>` → the sequence number of the last message a person approved. */
  approvedSeq: Record<string, number>;
}

export type Transport =
  | { kind: "ssh"; config: string; host: string }
  | { kind: "command"; argv: string[] };

export interface Refusal {
  id: string;
  /** A fixed code (reasons.ts), never free text. */
  code: string;
  retry?: boolean;
}

export interface DirectoryEntry {
  agent: string;
  allows: string[];
}

export interface Pair {
  pairId: string;
  /** This machine's label for the other one. */
  name: string;
  /** The caller runs the exchange over its transport; the answerer answers it. */
  role: "caller" | "answerer";
  state: "linked" | "active" | "paused";
  remoteMachineId: string;
  /** What the other machine calls itself; shown, never trusted as a label. */
  remoteName: string;
  remote: { enabled: boolean; paused: boolean };
  linkedAt: string;
  lastContact: string | null;
  lastError: string | null;
  /** The other machine's agents open to this pairing, as it says. */
  directory: DirectoryEntry[];
  transport?: Transport;
  /** The caller's acks and refusals for what it took last time, sent with the next call. */
  pendingAcks: string[];
  pendingRefused: Refusal[];
}

export interface Invite {
  /** The pairing this code makes; the forced command of its key names it. */
  pairId: string;
  key: string;
  expires: number;
  tries: number;
  name: string | null;
}

export type OutStatus =
  "queued" | "in-flight" | "delivered" | "refused" | "expired" | "unsent";

export interface OutMsg {
  /** Shared with the inbox's numbers, so the two can be ordered together. */
  seq: number;
  id: string;
  agent: string;
  pairId: string;
  machine: string;
  to: string;
  kind: "msg" | "reply";
  /** For a reply: the other side's id of the message it answers. */
  replyTo?: string;
  text: string;
  at: string;
  status: OutStatus;
  reason?: string;
  resultAt?: string;
  leaseUntil?: number;
  /** Handed to the other machine at least once: it may have arrived. */
  handed?: boolean;
  approved: boolean;
}

export interface InMsg {
  seq: number;
  /** The id this agent sees (local, random). */
  id: string;
  /** The other side's id of the item, for replies and receipts. */
  itemId: string;
  agent: string;
  pairId: string;
  machine: string;
  from: string;
  kind: "msg" | "reply";
  /** For a reply: the id of our message it answers. */
  replyTo?: string;
  text: string;
  sentAt: string;
  at: string;
  /** For a msg: the id of our reply to it. */
  answeredBy?: string;
  /** peer_inbox has handed it to the agent. */
  read?: boolean;
}

export interface LedgerEntry {
  agent: string;
  key: string;
  fingerprint: string;
  messageId: string;
  at: number;
}

export interface State {
  v: 1;
  machineId: string;
  name: string;
  port: number;
  agents: Agent[];
  pairs: Pair[];
  invites: Invite[];
  inviteLog: number[];
  outbox: OutMsg[];
  inbox: InMsg[];
  /** `<pairId>:<itemId>` → when it was taken (ms). */
  seen: Record<string, number>;
  ledger: LedgerEntry[];
  nextSeq: number;
}

export class StateError extends Error {}
export class NotInitializedError extends StateError {}

/** The data directory: $COURIER_HOME, else ~/.config/agent-courier. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const own = env.COURIER_HOME;
  return own ? resolve(own) : join(homedir(), ".config", "agent-courier");
}

export function blankState(name: string, port: number): State {
  return {
    v: 1,
    machineId: newId(),
    name,
    port,
    agents: [],
    pairs: [],
    invites: [],
    inviteLog: [],
    outbox: [],
    inbox: [],
    seen: {},
    ledger: [],
    nextSeq: 1,
  };
}

function parseState(raw: string, file: string): State {
  let s: unknown;
  try {
    s = JSON.parse(raw);
  } catch {
    throw new StateError(`${file} is not valid JSON; it was left as it is`);
  }
  const ok =
    typeof s === "object" &&
    s !== null &&
    (s as State).v === 1 &&
    typeof (s as State).machineId === "string" &&
    UUID.test((s as State).machineId) &&
    typeof (s as State).name === "string" &&
    MACHINE_NAME.test((s as State).name) &&
    Number.isInteger((s as State).port) &&
    [
      "agents",
      "pairs",
      "invites",
      "inviteLog",
      "outbox",
      "inbox",
      "ledger",
    ].every((k) => Array.isArray((s as Record<string, unknown>)[k])) &&
    typeof (s as State).seen === "object" &&
    Number.isInteger((s as State).nextSeq);
  if (!ok)
    throw new StateError(
      `${file} is not an agent-courier state file; it was left as it is`,
    );
  return s as State;
}

export interface StoreOptions {
  now?: () => number;
  /** For tests: replaces the file write. */
  write?: (file: string, content: string) => void;
}

export class Store {
  readonly dir: string;
  readonly file: string;
  readonly now: () => number;
  readonly #write: (file: string, content: string) => void;

  constructor(
    dir: string,
    { now = Date.now, write = writePrivate }: StoreOptions = {},
  ) {
    this.dir = dir;
    this.file = join(dir, "state.json");
    this.now = now;
    this.#write = write;
  }

  /** Creates the directory and the state, or returns the existing state unchanged. */
  init(name: string, port = DEFAULT_PORT): { state: State; created: boolean } {
    if (!MACHINE_NAME.test(name))
      throw new StateError(
        "the machine name must be 1 to 40 lowercase letters, digits, dots or hyphens",
      );
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new StateError("the port must be a number from 1024 to 65535");
    ensurePrivateDir(this.dir);
    return withLock(this.dir, () => {
      const raw = readPrivate(this.file);
      if (raw !== null)
        return { state: parseState(raw, this.file), created: false };
      const state = blankState(name, port);
      this.#write(this.file, JSON.stringify(state));
      return { state, created: true };
    });
  }

  /** The state as it is now, without the lock (writes are whole-file renames). */
  read(): State {
    const raw = readPrivate(this.file);
    if (raw === null)
      throw new NotInitializedError(
        `no state in ${this.dir}: run courier init first`,
      );
    return parseState(raw, this.file);
  }

  /**
   * Runs fn on the state under the lock and writes the result. If fn throws, nothing is
   * written. A CommitUnknownError means the write is in place but may not be durable.
   */
  update<T>(fn: (s: State) => T): T {
    if (!existsSync(this.file))
      throw new NotInitializedError(
        `no state in ${this.dir}: run courier init first`,
      );
    return withLock(this.dir, () => {
      const s = this.read();
      const out = fn(s);
      this.#write(this.file, JSON.stringify(s));
      return out;
    });
  }
}

export { CommitUnknownError };

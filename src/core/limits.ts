// Every limit in one place. docs/mcp.md and docs/security.md list the same numbers.

/** A message holds words only: at most this many characters (UTF-16 code units)... */
export const TEXT_CHARS = 8000;
/** ...and at most this many bytes as a JSON string, as it travels. */
export const TEXT_BYTES = 12_000;
/** ...in at most this many lines, with at most this many blank lines in a row. */
export const MAX_LINES = 200;
export const MAX_BLANK_RUN = 2;
/** Messages an hour from one agent to one agent of a paired machine, each direction. */
export const HOURLY = 30;
/** An agent's own messages that may wait to be taken at one time. */
export const WAITING_OUT = 10;
/** Messages that may wait unread in an agent's inbox. */
export const WAITING_IN = 10;
/** Messages back and forth between two agents without a human approval. */
export const LOOP = 12;
/** A message waiting longer than this expires. */
export const EXPIRE_MS = 24 * 3600_000;
/** How long a message handed to the other side is out on a lease before it may go again. */
export const LEASE_MS = 120_000;
/** Ids already taken from the other side are remembered this long. */
export const SEEN_MS = 7 * 24 * 3600_000;
/** A message's own time may be this far ahead of ours... */
export const FUTURE_MS = 5 * 60_000;
/** ...and this far behind. */
export const OLD_MS = 24 * 3600_000;
/** Messages are kept this long after they settle, and at most this many per agent and direction. */
export const KEEP_MS = 7 * 24 * 3600_000;
export const KEEP_PER_AGENT = 200;

/** One exchange: all items together, one item, the whole body. */
export const BATCH_BYTES = 190 * 1024;
export const ITEM_BYTES = 16 * 1024;
export const BODY_BYTES = 256 * 1024;
/** Items per exchange, acks and refusals per exchange, directory entries. */
export const MAX_ITEMS = 100;
export const MAX_SETTLED = 200;
export const MAX_DIRECTORY = 200;

/** Pairing codes: open for ten minutes, five wrong tries, ten codes an hour. */
export const INVITE_MS = 10 * 60_000;
export const INVITE_TRIES = 5;
export const INVITES_HOURLY = 10;

/** The calling side's loop: one exchange every 15 to 20 s, backing off to 5 min. */
export const POLL_MS: readonly [number, number] = [15_000, 20_000];
export const BACKOFF_MAX_MS = 5 * 60_000;
export const TRANSPORT_TIMEOUT_MS = 30_000;
/** The forced command waits this long for the whole request on stdin. */
export const EXCHANGE_READ_MS = 20_000;

/** Approvals: how long the person has to answer, and how many questions may wait. */
export const CONFIRM_TTL_MS = 60_000;
export const CONFIRM_PER_AGENT = 4;
/** An idempotency key is remembered this long. */
export const LEDGER_MS = 24 * 3600_000;
/** The MCP request body. */
export const MCP_BODY_BYTES = 128 * 1024;
/** Messages in one peer_inbox page. */
export const INBOX_PAGE = 20;

export const MAX_AGENTS = 50;
export const MAX_ALLOW = 50;
export const MAX_PAIRS = 20;

export const DEFAULT_PORT = 47_800;

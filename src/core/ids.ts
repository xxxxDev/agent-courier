// Fixed formats for everything that names something. Anything else is refused, at the
// MCP boundary, on the wire and in the CLI.

import { createHash, randomBytes, randomUUID } from "node:crypto";

/** A local agent: lowercase letters, digits and inner hyphens, 1 to 32 characters. */
export const AGENT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** Your label for a paired machine: like a host name, 1 to 40 characters. */
export const MACHINE_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,38}[a-z0-9])?$/;
/** Message, pairing and machine ids: a lowercase random UUID. */
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** An idempotency key: 8 to 128 printable ASCII characters, no spaces. */
export const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;
/** An inbox cursor: a decimal sequence number. */
export const CURSOR = /^(0|[1-9][0-9]{0,14})$/;
/** An agent's bearer token. */
export const TOKEN = /^cour_[A-Za-z0-9_-]{43}$/;

export const newId = (): string => randomUUID();
export const newToken = (): string =>
  `cour_${randomBytes(32).toString("base64url")}`;
export const sha256 = (v: string): string =>
  createHash("sha256").update(v).digest("hex");

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** A pairing code: 20 base32 characters (100 bits), shown in groups of four. */
export function newCode(): string {
  const bytes = randomBytes(20);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join("");
  return chars.match(/.{4}/g)!.join("-");
}
/** A code is typed back with or without dashes, in either case; only its letters count. */
export const codeKey = (code: string): string =>
  sha256(
    `agent-courier-invite:${code.toUpperCase().replace(/[^A-Z2-7]/g, "")}`,
  );

/**
 * Message text: words only. Tabs and line breaks are allowed; other control characters
 * (C0, DEL, C1) are not, so text cannot carry terminal escapes. Nor are the bidirectional
 * embedding, override and isolate characters, which could reorder how the text looks in an
 * approval question; the directional marks (U+200E, U+200F) stay allowed.
 */
export const TEXT_OK =
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
  /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]*$/;

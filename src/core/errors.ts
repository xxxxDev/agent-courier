// One error type for refusals the person or the agent should read. `kind` picks the
// prefix an agent sees (docs/mcp.md, "Errors") and the CLI's exit code.

export type ErrorKind =
  "invalid" | "not-found" | "conflict" | "denied" | "limit" | "unreachable";

export class CourierError extends Error {
  readonly kind: ErrorKind;
  /** For a limit the other side may lift by itself: trying later can work. */
  readonly retry: boolean;
  constructor(kind: ErrorKind, message: string, retry = false) {
    super(message);
    this.kind = kind;
    this.retry = retry;
  }
}

export const invalid = (m: string) => new CourierError("invalid", m);
export const notFound = (m: string) => new CourierError("not-found", m);
export const conflict = (m: string) => new CourierError("conflict", m);
export const denied = (m: string) => new CourierError("denied", m);
export const limit = (m: string, retry = true) =>
  new CourierError("limit", m, retry);

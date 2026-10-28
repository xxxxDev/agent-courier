// Why the receiving machine refused a message, as a fixed code on the wire. The sending
// machine shows only its own text for a code it knows, so no words chosen by the other
// machine reach peer_status or the agent.

export const REFUSAL_TEXT = {
  "not-open": "that agent is not open to this one",
  "bad-text": "the text is not allowed there",
  "not-a-reply": "not a reply to a message from this agent",
  "already-answered": "already answered",
  hourly: "too many messages this hour",
  unread: "too many messages wait unread for that agent",
  loop: "the two agents have written back and forth too often without a person approving",
  "too-large": "too large",
  format: "not in the expected format",
  "wrong-pairing": "sent over the wrong pairing",
  "not-on": "the pairing is not on at that end",
  "too-old": "too old or from the future",
} as const;

export type RefusalCode = keyof typeof REFUSAL_TEXT;

/** What peer_status shows for a code the other machine sent. */
export const remoteReason = (code: string): string =>
  Object.hasOwn(REFUSAL_TEXT, code)
    ? `the other machine: ${REFUSAL_TEXT[code as RefusalCode]}`
    : "the other machine refused it (a reason not known here)";

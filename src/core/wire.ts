// The exchange between two machines, as JSON over the transport (docs/design.md,
// "Exchange"). Everything that arrives is parsed with these schemas; an item that does not
// fit is refused on its own, the rest of the exchange goes on.

import { z } from "zod";
import { AGENT_NAME, UUID } from "./ids.ts";
import { MAX_DIRECTORY, MAX_ITEMS, MAX_SETTLED } from "./limits.ts";

export const V = 1;

const uuid = z.string().regex(UUID);
const agentName = z.string().regex(AGENT_NAME);

export const PairRequest = z.strictObject({
  v: z.literal(V),
  pair: z.strictObject({
    code: z.string().max(64),
    machineId: uuid,
    name: z.string().max(64),
  }),
});

export const PairAnswer = z.strictObject({
  v: z.literal(V),
  pair: z.union([
    z.strictObject({
      ok: z.literal(true),
      pairId: uuid,
      machineId: uuid,
      name: z.string().max(64),
    }),
    z.strictObject({ ok: z.literal(false), reason: z.string().max(64) }),
  ]),
});

export const Item = z.strictObject({
  id: uuid,
  pairId: uuid,
  kind: z.enum(["msg", "reply"]),
  from: agentName,
  to: agentName,
  replyTo: uuid.optional(),
  at: z.string().max(40),
  text: z.string(),
});

export const DirectoryEntry = z.strictObject({
  agent: agentName,
  allows: z.array(agentName).max(MAX_DIRECTORY),
});

export const Refused = z.strictObject({
  id: uuid,
  code: z.string().regex(/^[a-z-]{1,32}$/),
  retry: z.boolean().optional(),
});

export const Envelope = z.strictObject({
  v: z.literal(V),
  pairId: uuid,
  from: z.strictObject({ machineId: uuid, name: z.string().max(64) }),
  state: z.strictObject({ enabled: z.boolean(), paused: z.boolean() }),
  directory: z.array(z.unknown()).max(MAX_DIRECTORY),
  items: z.array(z.unknown()).max(MAX_ITEMS),
  acks: z.array(uuid).max(MAX_SETTLED),
  refused: z.array(Refused).max(MAX_SETTLED),
});

export const UnknownPair = z.strictObject({
  v: z.literal(V),
  unknownPair: z.literal(true),
});

export type Envelope = z.infer<typeof Envelope>;

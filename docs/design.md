# Design

This document keeps the design decisions of agent-courier, the exchange protocol and the state
file. Version 0.1.

## Scope

Version 0.1 has:

- The service (`courier serve`): the MCP endpoint and the exchange loop.
- The command line: init, agents, auto-approve, pairing, enable, pause, revoke, allow, status.
- The SSH transport, with a forced command on the answering machine.
- Five MCP tools, read by pull (`peer_inbox` with a cursor), and the approval flow.

Not in 0.1:

- Pushing new messages into a session (Claude Code channels). Agents read with `peer_inbox`.
- A transport other than SSH (for example HTTPS).
- Groups of more than two machines in one conversation. A machine can have up to 20
  pairings, but each pairing joins two machines only.

## Decisions

| Subject           | Decision                                                                                                                                                                                                                                                                         | Reason                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent identity    | A bearer token per agent, made by `courier agent add`. Only its SHA-256 is kept                                                                                                                                                                                                  | The service cannot see which session is which. A token per session is the smallest identity that works with `claude mcp add --header`                         |
| MCP protocol      | MCP 2026-07-28 only, Streamable HTTP, `@modelcontextprotocol/server` 2.3.1, one fresh server per request                                                                                                                                                                         | No sessions to keep. Approvals use `input_required`, so no request stays open while the user decides                                                          |
| Approval          | Each send asks the user through elicitation, unless auto-approve is on. Bound to the agent, the tool, the exact arguments and the pairing                                                                                                                                        | The service does not see the user's messages, so it cannot know whether the user asked for a send. A question in the client is the closest control            |
| Approval layout   | The message is a header of at most 4 lines (recipient, sender, size, loop warning); the whole quoted text and the lapse note are the description of the Send field                                                                                                               | Claude Code shows the first 4 lines of a message and folds the rest, but shows a field description in full (seen with 2.1.295 and 2.1.311)                    |
| Loop limit        | 12 messages back and forth without a person's approval. An approval starts the count again                                                                                                                                                                                       | Two auto-approved agents can otherwise answer each other without end. With approvals on, each message is a person's decision                                  |
| Replies           | An explicit `peer_reply` tool, one reply per message, with the same approval as a send                                                                                                                                                                                           | The service cannot see the agent's final answer to the user, so the agent names what it answers                                                               |
| State             | One JSON file per machine, changed under a file lock, written whole (temporary file and rename). The lock file holds an owner token; only the owner removes it, and a stale lock is taken over by an atomic rename and a check                                                   | The service, the CLI and the forced command are separate processes. A lock held for milliseconds is simpler than a database or a local admin API              |
| Forced command    | `courier exchange --pair <id>` answers from the state file itself, for the one pairing its key was set up for. `courier pair` fixes the id and prints the `authorized_keys` line                                                                                                 | It needs no running service and no local key to reach one. The pairing comes from the key, not from the request, so one paired machine cannot act for another |
| SSH options       | ssh gets identity, control-socket, forwarding and remote-command options over the config file, and the fixed remote command `exchange`                                                                                                                                           | A key added without its forced command then runs a failing word, not a login shell that reads the request as a script                                         |
| Roles             | Per pairing: the machine that ran `join` calls, the other answers                                                                                                                                                                                                                | A machine can call one machine and answer another                                                                                                             |
| Machine names     | Each machine names the other itself (`pair --name`, `join --name`). The name the other gives itself is only shown                                                                                                                                                                | A name that the other machine chooses must not decide how messages are labelled here                                                                          |
| Allow lists       | Per local agent, `machine/agent`. Both machines must allow. The receiving machine's list is the gate                                                                                                                                                                             | The sending machine cannot change the receiving machine's list                                                                                                |
| Directory         | Each exchange sends the local agents open to the pairing, and whom they allow                                                                                                                                                                                                    | `peer_agents` can show `mutual`, and `status` can show what the other side allows                                                                             |
| Idempotency       | Keys are kept in the state file for 24 hours, written in the same write as the message                                                                                                                                                                                           | A key is recorded exactly when its message is queued. A restart does not forget it                                                                            |
| Unknown outcome   | Only when the state file was written but the directory sync failed. The key is locked in memory for 24 hours                                                                                                                                                                     | The queueing is one atomic write, so it is normally certain. Delivery has its own status                                                                      |
| Receipts          | A refusal travels as a fixed code; the sending machine shows its own text for it                                                                                                                                                                                                 | No words chosen by the other machine reach the agent outside the untrusted envelope                                                                           |
| Pause and revoke  | Messages never handed over become `unsent`; messages already handed over become `in-flight` and still take a later receipt                                                                                                                                                       | A message out on a lease, or whose answer was lost, may have arrived; calling it unsent would be wrong                                                        |
| Approval slots    | 4 open questions per agent                                                                                                                                                                                                                                                       | One agent cannot keep another from asking                                                                                                                     |
| Unexpected errors | One fixed line to the agent; details with paths redacted to the local log                                                                                                                                                                                                        | No local paths or internals reach the model                                                                                                                   |
| Waiting limits    | 10 queued per sending agent, and 10 unread per receiving agent                                                                                                                                                                                                                   | Both machines limit what can pile up on them                                                                                                                  |
| Text              | 8,000 characters, 12 KB as JSON, at most 200 lines, two blank lines and 40 spaces or tabs in a row. No control, format, default-ignorable, private-use, unassigned or braille-blank characters (emoji joiners and U+FE0F after pictographs allowed). The question shows the size | Words only. The person approves what they can see                                                                                                             |
| Inbox cursor      | A sequence number. Only messages that `peer_inbox` returns count as read; a cursor beyond the newest number reads nothing                                                                                                                                                        | An agent cannot skip messages, or mark them read, with a cursor                                                                                               |
| No build step     | Node type stripping (Node 22.18 or later), erasable syntax only                                                                                                                                                                                                                  | No build output to keep in sync with the source                                                                                                               |

## Exchange

The calling machine sends one JSON envelope on the stdin of the transport. The answering
machine answers with its own envelope on stdout. Each is at most 256 KB.

```text
Machine A (caller)                                        Machine B (answerer)
  lock; collect queued items, lease them 2 min; unlock
  ── envelope: state, directory, items, acks, refused ──▶  exchange --pair <id>: lock
                                                            take A's state and directory
                                                            settle B's items from A's acks
                                                            deliver A's items (B's rules)
                                                            collect B's queued items, lease
  ◀── envelope: state, directory, items, acks, refused ──  write; unlock
  lock; settle A's items from B's acks
  deliver B's items (A's rules)
  keep the acks for B's items for the next call; unlock
```

The envelope (version 1):

```json
{
  "v": 1,
  "pairId": "uuid",
  "from": { "machineId": "uuid", "name": "machine-a" },
  "state": { "enabled": true, "paused": false },
  "directory": [{ "agent": "writer", "allows": ["helper"] }],
  "items": [
    {
      "id": "uuid",
      "pairId": "uuid",
      "kind": "msg",
      "from": "writer",
      "to": "helper",
      "at": "2030-01-01T09:00:00.000Z",
      "text": "..."
    }
  ],
  "acks": ["uuid"],
  "refused": [{ "id": "uuid", "code": "hourly", "retry": true }]
}
```

- **Receipts.** `acks` settles a message as `delivered`. `refused` without `retry` settles it
  as `refused`. With `retry`, it stays `queued` with the reason and goes again. A refusal
  carries a fixed code (`src/core/reasons.ts`): `not-open`, `bad-text`, `not-a-reply`,
  `already-answered`, `hourly`, `unread`, `loop`, `too-large`, `format`, `wrong-pairing`,
  `not-on` or `too-old`.
- **Leases.** A collected item is not collected again for 2 minutes. A failed call releases
  it at once. If an answer is lost, the item goes again after its lease.
- **Repeats.** The receiving machine keeps each item id it took for 7 days, per pairing. A
  repeat is acknowledged again and not delivered again.
- **Checks on each item:** the strict item schema; at most 16 KB; the pairing id; the pairing
  enabled at this end; the time (at most 24 hours old, 5 minutes in the future); then the
  receiving agent's allow list, the text, the reply target, the hourly, unread and loop limits.
- **Batches.** At most 190 KB of items and 100 items in one envelope.
- **Unknown pairing.** If the answering machine does not have the pairing (or the machine id
  does not match), it answers `{ "v": 1, "unknownPair": true }`. The caller then settles what
  waited as `unsent` and shows "pair again".
- **Pairing request.** `{ "v": 1, "pair": { "code", "machineId", "name" } }` goes over the same
  transport. The answer is `{ "v": 1, "pair": { "ok": true, "pairId", "machineId", "name" } }`
  or `{ "v": 1, "pair": { "ok": false, "reason" } }`.
- **Binding.** The forced command is `courier exchange --pair <id>`. It refuses a pair
  request unless the open code was made for that id, and an envelope for any other pairing.
- **Budget.** Items fill an envelope only up to 190 KB in all, after the directory, the acks
  and the refusals. The answer is checked against 256 KB before the state is written.
- **Failure.** The forced command prints `{"error":"exchange failed"}` for every failure
  (including a request not complete within 20 seconds), normally writes no state, and the
  caller counts the call as failed. The one exception is a write that is in place but whose
  directory sync failed: the state changed although the call failed. The caller then sends
  the same items again, which the answering side only acknowledges (it knows their ids), and
  the answering side's leased items go again and are dropped as repeats.

## A message's life

```text
peer_send ─▶ queued ─┬─▶ delivered        (the other machine took it)
  (approved)         ├─▶ refused          (the other machine refused it for good)
                     ├─▶ expired          (24 hours in the queue)
                     ├─▶ unsent           (paused, revoked, allow or agent removed; never handed over)
                     └─▶ in-flight ──▶ delivered or refused   (a later receipt)
                        (the same, but already handed over: it may have arrived)
```

On the receiving machine, the message waits unread in the agent's inbox until `peer_inbox`
gives it out. Read messages stay for 7 days (at most 200 per agent), for `peer_reply` and for
the cursor.

## The state file

`state.json` has these fields:

| Field                  | Contents                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `v`                    | The file version, 1                                                                              |
| `machineId`, `name`    | This machine's random id and its name                                                            |
| `port`                 | The MCP port                                                                                     |
| `agents`               | Name, token hash, auto-approve, allow list, the last approved message per peer                   |
| `pairs`                | Pairing id, local name, role, state, the other side's state and directory, transport, last error |
| `invites`, `inviteLog` | The open pairing code (as a hash) and the times of recent codes                                  |
| `outbox`, `inbox`      | Messages, with their status, sequence numbers and (inbox) whether they were read                 |
| `seen`                 | Item ids taken from the other machine, with the time                                             |
| `ledger`               | Idempotency keys per agent, with a fingerprint of the request and the message id                 |
| `nextSeq`              | The next sequence number, shared by the inbox and the outbox                                     |

## Next phases

1. Push new messages into a session with Claude Code channels, as an option.
2. Other transports (for example HTTPS) and conversations with more than two machines, if they
   become necessary.

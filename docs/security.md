# Security model

agent-courier is for one person with two or more machines. The design has these objectives:

- No third party carries or sees the messages. They go only over SSH between your machines.
- Web pages and programs without a token cannot use the MCP endpoint.
- A paired machine can reach only the agents that this machine allows, only over its own
  pairing, and only with text.
- The model sends only after you approve, unless you turned on auto-approve for that agent.
- Incoming text reaches the agent marked as untrusted data, never as your instructions.
- The repo contains no secrets. agent-courier writes its files 0600, in a 0700 directory.

These objectives are about the model and about other machines and users. They do not cover
programs that run as your own user on the same machine: refer to
[Conditions of the design](#conditions-of-the-design).

## Network

- The MCP endpoint listens only on `127.0.0.1`. Machine B opens no new port: the exchange comes
  in through its SSH server.
- Each MCP request must have `Host: 127.0.0.1:<port>` or `Host: localhost:<port>`. Other hosts
  get 421. This prevents DNS rebinding attacks.
- Each MCP request with an `Origin` header gets 403. Agents are not browsers.
- The endpoint accepts only `POST /mcp`, with a body of at most 128 KB.
- Between machines, the messages travel only inside SSH. Whatever the config file says, ssh
  runs with `BatchMode=yes`, `StrictHostKeyChecking=yes`, `IdentitiesOnly=yes`,
  `IdentityAgent=none`, `ControlMaster=no`, `ControlPath=none`, `RemoteCommand=none`,
  `RequestTTY=no`, `ClearAllForwardings=yes`, `ForwardAgent=no`, `ForwardX11=no` and
  `PermitLocalCommand=no`. The host key must already be in the known-hosts file. No shared
  connection is used.
- Only the keys that the config file names for the host are offered (`IdentitiesOnly=yes`,
  no agent). With no `IdentityFile` for the host, ssh would offer the default keys
  (`~/.ssh/id_*`) instead, so `courier join` reads the effective config with `ssh -G` and
  refuses a host that names no `IdentityFile`, or names a default key. The config file can
  still change later: keep `IdentityFile` pointing at the dedicated key.
- ssh runs without a local shell. The host is an alias of 1 to 64 letters, digits, dots,
  hyphens or underscores, after `--`, so it cannot be an ssh option.
- ssh always sends the fixed remote command `exchange`. The forced command on machine B
  replaces it. If the key was added without its forced command, machine B runs the word
  `exchange`, which fails, instead of a login shell that would read the request (and the text
  of messages) from stdin as a script.
- The config file itself is yours: options that this list does not override, such as
  `ProxyCommand` or `ProxyJump`, still apply.

## Authentication

- **MCP:** Each agent has its own random bearer token (`cour_` and 32 random bytes). The
  service keeps only its SHA-256 hash and compares hashes in constant time. The token is shown
  one time, when you add the agent. A removed agent's token stops at once.
- **Between machines:** One dedicated SSH key per pairing, allowed on machine B only with a
  forced command and `restrict`. The forced command is `courier exchange --pair <id>`: the key
  can make that one pairing and exchange for it, and nothing else. `courier exchange` ignores
  `SSH_ORIGINAL_COMMAND`, refuses any other arguments, reads at most 256 KB of JSON within 20
  seconds and writes one JSON answer. When it fails, it prints one fixed line, never a path, a
  name or a reason, and normally it changes no state. One exception: the state file was
  written but the directory could not be synced afterwards. Then the exchange is reported as
  failed although its changes are in place. This is harmless: the caller sends the same items
  again, this machine recognizes their ids and only acknowledges them, and what this machine
  handed out goes again after its lease and is dropped as a repeat on the other side.
- **Pairing:** A one-time code of 100 random bits. It works for 10 minutes, one time. Five wrong
  codes cancel it. 10 codes an hour at most. The code is stored only as a hash. The pairing id
  is fixed when the code is made, and only the key whose forced command names that id can
  redeem the code.
- **Pairing state:** A pairing starts off. Each machine enables it with its own command.

## Trust between machines

- **The unit of trust is a pairing.** The receiving machine knows which pairing a message came
  over from the forced command of the SSH key, not from the request. Another paired machine
  that knows this pairing's ids cannot use them: its key names its own pairing. The name of the
  sending agent is what the other machine says. agent-courier cannot check it.
- **The receiving machine's allow list is the real gate.** A message reaches an agent only if
  that agent allows the sender's `machine/agent` on this machine. The sending machine checks
  its own list too, but the other machine cannot change yours.
- **The receiving machine applies its own limits:** text rules and size, 30 messages an hour,
  10 unread, the loop limit, the age of the message. Repeated messages are dropped by id for 7
  days.
- **Text only.** No files, no paths, no commands travel. Each item is checked against a strict
  schema; an item that does not match is refused.
- **No free text in receipts.** When the receiving machine refuses a message, it sends a fixed
  code. The sending machine shows its own text for a code it knows, and a fixed text for any
  other code. Words chosen by the other machine never reach `peer_status`.

## Secrets

| Secret                           | Location                                                     | Mode         | Notes                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent token                      | Shown once by `courier agent add`                            | —            | Not stored by agent-courier. A program with it is that agent and can answer its approval questions                                                         |
| Copy of the agent token          | Claude Code's configuration, written by `claude mcp add`     | The client's | With the default (local) scope, it is in `~/.claude.json`. Do not use `--scope project`: it writes `.mcp.json` into the project, which can be committed    |
| Copy in shell history            | Your shell's history file, if you ran `claude mcp add` there | The shell's  | Run the command with a leading space when your shell ignores those (`HISTCONTROL=ignorespace`), or remove the line afterwards                              |
| Token hashes, pairings, messages | `~/.config/agent-courier/state.json`                         | 0600         | Holds the text of messages for 7 days. A program that can write it can act as any agent                                                                    |
| Data directory                   | `~/.config/agent-courier/`                                   | 0700         | `COURIER_HOME` moves it                                                                                                                                    |
| Dedicated SSH private key        | Machine A, for example `~/.ssh/courier-b`                    | 0600         | With it, a program can exchange for that one pairing: deliver to machine B's agents that allow machine A's agents, and take what they queued for machine A |
| Pinned host key                  | Machine A, for example `~/.ssh/known_hosts_courier`          | 0644         | Not secret, but its integrity matters                                                                                                                      |
| Forced-command line              | Machine B, `~/.ssh/authorized_keys`                          | 0600         | Names one pairing. Remove the line to revoke the key                                                                                                       |
| Pairing code                     | Shown once by `courier pair`                                 | —            | Stored only as a hash. One use, 10 minutes                                                                                                                 |

agent-courier reads `state.json` only if all these conditions are true:

- The file is a regular file, not a symbolic link.
- The user of the process owns the file.
- The group and other users cannot read or write it.

It writes the file whole: a new temporary file (0600), then a rename. A damaged or unknown file
is left as it is and reported; agent-courier does not start afresh over it. Changes are made
under a lock file that holds its owner's token. A process removes only its own lock, and takes
over a lock only when its process is gone or it is older than 60 seconds.

## Agent limits

- An agent knows only its own token. No tool takes the name of the calling agent: the token
  decides it.
- No tool accepts a file path, a URL or a command. All ids have fixed formats; all schemas
  refuse extra fields.
- Each `peer_send` and `peer_reply` asks you first, in the MCP client, unless auto-approve is
  on. The question's message (at most 4 lines) names the recipient and gives the size of the
  text in characters and lines. The whole text, each line quoted, is the description of the
  question's Send field: Claude Code shows only the first 4 lines of a message, but a field's
  description in full (Claude Code 2.1.311; 2.1.295 cuts long lines there, so approve in 2.1.311 or later). The approval is bound to the exact arguments,
  the agent and the pairing. It lapses after 60 seconds. Each agent can have at most 4
  questions open, so one agent cannot block the questions of another.
- How the question looks is up to the client. agent-courier makes sure that the text has
  nothing that does not show: it refuses control characters other than tabs and line breaks,
  format and default-ignorable characters (zero-width characters, joiners, word joiners, tag
  characters, variation selectors, bidirectional controls and the like), private-use and
  unassigned code points, line or paragraph separators, and the braille blank (U+2800). It
  allows at most 40 spaces or tabs in a row. Ordinary emoji keep their
  variation selector and the joiners between pictographs. A text has at most 200 lines and at
  most two blank lines in a row.
- After you approve, the server checks the allow lists, the pairing and the limits again.
- If the client cannot ask, sends are refused unless auto-approve is on.
- With auto-approve, 12 messages back and forth without an approval stop the pair until you
  approve one.
- Each send has an `idempotency_key`. A key is used one time per agent for 24 hours. An unknown
  outcome locks the key for 24 hours.
- Incoming text comes in a JSON envelope: `untrusted: true`, a notice, the sender
  (`machine` and `agent`) and the text. JSON keeps the text inside a string, so text that
  imitates the envelope cannot leave it.
- An unexpected error gives the agent one fixed line. The details go only to the service log,
  with absolute paths replaced.

## Conditions of the design

These are the limits of what agent-courier can do. Plan for them.

- **Approvals guard against the model, not against local code.** An agent that can run shell
  commands as your user can run `courier auto-approve <agent> on`, read its token from Claude
  Code's configuration, or change `state.json`. Then it can send without a question. Keep
  agents that have shell access in a sandbox that denies read and write access to the data
  directory and to Claude Code's configuration, and that denies running `courier`.
- **The client sends your answer to the server.** Claude Code shows the approval question and
  sends your answer. The server cannot see if you clicked or if a program answered. Use a client
  that you trust.
- **Same user, same trust.** On one machine, every program that runs as your user can read
  `state.json`, the SSH key and the client configuration, unless a sandbox stops it. Such a
  program can add agents, change allow lists or send as any agent. agent-courier does not
  protect against the user's own unsandboxed programs.
- **Trust is per pairing.** If machine A is compromised, it can deliver to every agent on
  machine B that allows any agent of machine A, name any of its agents as the sender, and take
  what machine B queued for machine A. It cannot use another machine's pairing.
- **An agent keeps what it read.** agent-courier cannot take text back from an agent or from the
  client. Pausing or revoking stops only what has not been handed over. A message that was
  already handed over shows `in-flight`: it may have arrived.
- **Untrusted text is an instruction to the model, not a barrier.** The envelope and its notice
  tell the agent that the text is data. A model can still follow text in it. Keep your approval
  on for agents that can act on important systems.
- **Message text stays on disk for 7 days** in `state.json` on both machines, and in the
  client's conversation history. Use disk encryption on both machines.
- **The directory of agents is shared with the paired machine.** Each exchange tells the other
  machine which local agents are open to it and whom they allow.
- **Clocks.** A message older than 24 hours or more than 5 minutes in the future is refused.
  Keep the clocks of both machines correct.

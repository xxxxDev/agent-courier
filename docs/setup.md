# Setup

agent-courier connects two machines. In this guide, **machine A** calls and **machine B**
answers:

- Machine A needs SSH access to machine B.
- Machine B needs only its SSH server. It gets no new open port.
- Each machine runs `courier serve` for its own Claude Code sessions.

The examples use the names `machine-a`, `machine-b`, `writer` (an agent on A) and `helper` (an
agent on B). Use your own names.

## Requirements

- Node 22.18 or later. agent-courier runs its TypeScript files directly with Node type
  stripping. There is no build step.
- Git and npm.
- OpenSSH: the client on machine A, the server on machine B.
- Claude Code that speaks MCP 2026-07-28 and supports form elicitation. Versions 2.1.295 and
  2.1.311 were tested; approve sends in 2.1.311 or later, because 2.1.295 cuts long lines in the
  approval question. Refer to [mcp.md](mcp.md#protocol).

## Install

Do these steps on both machines.

```bash
git clone https://github.com/xxxxDev/agent-courier.git ~/agent-courier
cd ~/agent-courier
npm ci
npm link     # puts `courier` on your PATH
```

Node does not strip types from files under `node_modules`. Thus install from a checkout, as
shown. `npm link` makes a symbolic link to the checkout, so this works. Without `npm link`, use
`node ~/agent-courier/bin/courier.js` in place of `courier`.

## The data directory

Each machine keeps its state in one directory. The default is `~/.config/agent-courier`. To use
a different directory, set `COURIER_HOME`.

| Item         | Path                       | Mode |
| ------------ | -------------------------- | ---- |
| Directory    | `~/.config/agent-courier/` | 0700 |
| State        | `.../state.json`           | 0600 |
| Lock (short) | `.../state.lock`           | 0600 |

All `courier` commands, `courier serve` and the forced command use the same file. Each change
locks the file for some milliseconds. Thus the commands work while `courier serve` runs.

## 1. Initialize

On machine A:

```bash
courier init --name machine-a
```

On machine B:

```bash
courier init --name machine-b
```

- `--name` is the name that this machine gives itself. It is 1 to 40 lowercase letters, digits,
  dots or hyphens.
- `--port` sets the MCP port on `127.0.0.1`. The default is 47800.
- `init` does not change an existing state.

## 2. Make a dedicated SSH key (machine A)

Make a key only for agent-courier. Do not use your usual key.

```bash
ssh-keygen -t ed25519 -N '' -f ~/.ssh/courier-b -C courier-machine-a
```

## 3. Write an SSH config file for the link (machine A)

Write a separate config file, for example `~/.ssh/courier-b.config`. Use your own host name and
user:

```text
Host courier-b
    HostName machine-b.example
    User you
    IdentityFile ~/.ssh/courier-b
    IdentitiesOnly yes
    IdentityAgent none
    UserKnownHostsFile ~/.ssh/known_hosts_courier
    StrictHostKeyChecking yes
    RequestTTY no
```

`IdentityFile` is required, and it must be the dedicated key. Without it, ssh would offer
your default keys (`~/.ssh/id_*`). `courier join` checks this with `ssh -G` (which only reads
the config) and refuses a host with no `IdentityFile` or with a default key.

agent-courier also gives ssh these options itself, over the config file: `-T`,
`BatchMode=yes`, `StrictHostKeyChecking=yes`, `IdentitiesOnly=yes`, `IdentityAgent=none`,
`ControlMaster=no`, `ControlPath=none`, `RemoteCommand=none`, `RequestTTY=no`,
`ClearAllForwardings=yes`, `ForwardAgent=no`, `ForwardX11=no` and `PermitLocalCommand=no`.
It also sends the fixed remote command `exchange`, which the forced command replaces.

Put the host key of machine B into `~/.ssh/known_hosts_courier`. Compare the fingerprint with
the key on machine B before you trust it:

```bash
# On machine B: show the fingerprint of its host key.
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
# On machine A: get the key, show its fingerprint, and compare the two.
ssh-keyscan -t ed25519 machine-b.example > ~/.ssh/known_hosts_courier
ssh-keygen -lf ~/.ssh/known_hosts_courier
```

## 4. Make a pairing code (machine B)

On machine B, make a one-time code. `--name` is the name that machine B gives machine A:

```bash
courier pair --name machine-a
```

The command shows the code and the line for `authorized_keys`, for example:

```text
Pairing code: ABCD-EFGH-IJKL-MNOP-QRST
...
  command="/usr/local/bin/node /home/you/agent-courier/bin/courier.js exchange --pair 6f1c2b9e-0b7a-4c55-9d3e-2a8f4c1e7b10",restrict <public key of machine-a>
```

- The code works one time, for 10 minutes. Five wrong codes cancel it. A machine can make 10
  codes in an hour.
- The pairing id after `--pair` is fixed now. Each new code has a new id, so use the line of
  the code that you give to machine A.
- `courier status` shows the line again for each pairing on the answering side.

## 5. Allow the key on machine B, with its forced command

Add the printed line to `~/.ssh/authorized_keys` on machine B. Replace
`<public key of machine-a>` with the content of `~/.ssh/courier-b.pub` from machine A (it
starts with `ssh-ed25519`).

- The line has absolute paths for `node` and for the checkout, as `courier pair` found them.
  If `COURIER_HOME` is set, the line starts with `/usr/bin/env COURIER_HOME=...`.
- `restrict` turns off port forwarding, agent forwarding, X11 forwarding and the terminal.
- With this key, `courier exchange --pair <id>` is the only program that SSH runs. It ignores
  `SSH_ORIGINAL_COMMAND` and answers only for that pairing. Another paired machine cannot use
  this pairing, even if it knows its ids.
- Use one key and one line for each pairing. If you pair the same machines again, replace the
  line with the new one.

Test the key from machine A. The forced command reads an empty request and prints a fixed
error. This result shows that the key, the host key and the forced command operate:

```bash
ssh -F ~/.ssh/courier-b.config courier-b < /dev/null
# {"error":"exchange failed"}
```

If you see a shell prompt, a login message or `exchange: command not found`, the key has no
forced command: correct the line in `authorized_keys`.

## 6. Join (machine A)

On machine A, give the code. `--name` is the name that machine A gives machine B:

```bash
courier join ABCD-EFGH-IJKL-MNOP-QRST --name machine-b \
  --ssh-host courier-b --ssh-config ~/.ssh/courier-b.config
```

## 7. Enable on both machines

The pairing starts off. Each machine enables it with its own name for the other machine:

```bash
courier enable machine-b    # on machine A
courier enable machine-a    # on machine B
```

Messages flow only when both machines have the pairing enabled. Each side learns the state
of the other at the next exchange.

## 8. Add agents and allow them

Each Claude Code session that uses agent-courier is one agent. Add an agent on each machine:

```bash
courier agent add writer    # on machine A
courier agent add helper    # on machine B
```

The command shows the token one time and a `claude mcp add` command, for example:

```bash
claude mcp add --transport http courier http://127.0.0.1:47800/mcp --header "Authorization: Bearer cour_..."
```

Run that command in the project directory of the session. It uses Claude Code's default
(local) scope, which keeps the token in your user configuration. Do not add `--scope project`:
that writes the token into `.mcp.json` in the project, which can end up in a commit. To keep
the token out of your shell history, start the command with a space if your shell ignores
such lines (`HISTCONTROL=ignorespace` in bash, `setopt HIST_IGNORE_SPACE` in zsh).

agent-courier keeps only a hash of the token. If you lose the token, remove the agent and add
it again.

Then allow the two agents to talk. Both machines must allow:

```bash
courier allow writer machine-b/helper    # on machine A
courier allow helper machine-a/writer    # on machine B
```

## 9. Run the service

Run `courier serve` on both machines and keep it running:

```bash
courier serve
```

- On machine A, the service makes one exchange with machine B every 15 to 20 seconds. After an
  agent sends, the exchange starts in 2 seconds. After errors, the interval increases to a
  maximum of 5 minutes.
- On machine B, the service gives the MCP endpoint to its sessions. The exchanges come through
  the forced command.

To start the service automatically, use a user service. An example for systemd:

```ini
# ~/.config/systemd/user/agent-courier.service
[Unit]
Description=agent-courier

[Service]
ExecStart=/usr/local/bin/node %h/agent-courier/bin/courier.js serve
Restart=on-failure

[Install]
WantedBy=default.target
```

On macOS, use a LaunchAgent with the same command.

## Start Claude Code sessions locally (macOS)

On macOS, start the Claude Code sessions that use agent-courier from a terminal on the machine
itself, not from an SSH login. A Claude Code started in an SSH session cannot read the login
keychain, so it reports "Not logged in". `courier serve` and the forced command do not need
the keychain.

## Day-to-day commands

| Command                                | Function                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `courier status` (`--json`)            | Agents, pairings, the state of the other side, the last error                                 |
| `courier agent list`                   | Agents, auto-approve, unread count and allowed agents                                         |
| `courier agent remove <name>`          | Stops the token. Its waiting messages become `unsent` (or `in-flight` if already handed over) |
| `courier auto-approve <agent> on\|off` | Sends without your approval. The loop limit still asks                                        |
| `courier allow` / `disallow`           | Changes who can talk. Both machines must allow                                                |
| `courier pause <machine>`              | Stops the pairing. Waiting messages become `unsent` (or `in-flight`)                          |
| `courier enable <machine>`             | Starts it again. Old messages do not go                                                       |
| `courier revoke <machine>`             | Removes the pairing. Waiting messages become `unsent` (or `in-flight`)                        |

To revoke the link fully, also remove the key line from `~/.ssh/authorized_keys` on machine B.

## Update

```bash
cd ~/agent-courier && git pull && npm ci
```

Then restart `courier serve`. Update both machines: the two must use the same exchange version.

## Problems

| What you see                                                              | Cause and fix                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `courier: the ssh config names no IdentityFile for ...`                   | Add `IdentityFile ~/.ssh/courier-b` (the dedicated key) to the `Host` block in the config file of step 3                                                                              |
| `courier: no state in ...: run courier init first`                        | The data directory is empty, or `COURIER_HOME` points to a different directory                                                                                                        |
| `the port is in use: is courier serve already running?`                   | Another process uses the port. Stop the other `courier serve`, or init with a different `--port`                                                                                      |
| `status` shows `last error: exited with 255`                              | ssh failed. Run the test in [step 5](#5-allow-the-key-on-machine-b-with-its-forced-command) and read the ssh message                                                                  |
| `status` shows `last error: the other machine could not answer`           | The forced command ran but failed: wrong path or wrong `--pair` id in `authorized_keys` (after pairing again, use the new line), no state on machine B, or a different `COURIER_HOME` |
| `status` shows `last error: timed out`                                    | Machine B did not answer in 30 seconds. Look at the network and at `sshd` on machine B                                                                                                |
| `status` shows `the other machine no longer has this pairing: pair again` | Machine B revoked or paired again. Make a new code on machine B and join again                                                                                                        |
| The agent gets `Refused: the pairing with ... is not on at both ends now` | Enable on both machines, and wait for one exchange (up to 20 seconds)                                                                                                                 |
| `peer_status` shows `refused`, `that agent is not open to this one`       | The receiving machine does not allow the sender. Run `courier allow` there                                                                                                            |
| Messages stay `queued`                                                    | The other side is paused, does not answer, or limits its inbox. `courier status` on both machines shows the reason. After 24 hours, messages expire                                   |
| Claude Code shows `unauthorized` (401)                                    | The token is wrong, or the agent was removed. Add the agent again and run the new `claude mcp add`                                                                                    |
| Claude Code cannot connect, error `-32022`                                | The client does not speak MCP 2026-07-28. Update Claude Code                                                                                                                          |
| The agent gets `Denied: ... this client cannot ask (MCP elicitation)`     | The client cannot show approval questions. Use a client with elicitation, or turn on `courier auto-approve` for that agent                                                            |
| `courier: .../state.json can be read by other users; run chmod 600 on it` | Someone changed the mode. Run `chmod 600` on the file (and `chmod 700` on the directory)                                                                                              |
| `could not lock .../state.lock`                                           | Another process holds the lock for more than 5 seconds. A lock older than 10 seconds is taken over automatically                                                                      |

| Claude Code shows the courier server as failed (`ECONNREFUSED`) after `courier serve` restarted | Claude Code does not reconnect by itself. Run `/mcp`, choose `courier`, then **Reconnect** |

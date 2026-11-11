# Development

## Tools

mise installs Node (refer to `mise.toml`). npm installs the packages in `package-lock.json`.
The JS tools (TypeScript, oxlint and prettier) are `devDependencies` in `package.json`.
`.npmrc` sets `min-release-age=14`: npm does not install a package version younger than 14
days.

Node runs the TypeScript files directly (type stripping). Thus the code uses only erasable
syntax: no `enum`, no `namespace`, no parameter properties. `tsc --noEmit` checks the types.

| Task                 | Function                                                               |
| -------------------- | ---------------------------------------------------------------------- |
| `mise run check`     | Runs prettier --check, tsc and oxlint. Each change must pass this task |
| `mise run fmt`       | Formats the repo with prettier                                         |
| `mise run typecheck` | Runs `tsc --noEmit`                                                    |
| `mise run lint`      | Runs oxlint on `src` and `bin`                                         |
| `mise run install`   | Runs `npm ci`                                                          |

Without mise, run `npm ci`, then the npm scripts: `npm run fmt:check`, `npm run typecheck` and
`npm run lint` (together, what `mise run check` runs), and `npm run fmt`.

## Source layout

| Path             | Contents                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/courier.js` | The `courier` command. It only starts `src/cli/main.ts`                                                                                                                                                                                                                                                                                                                                                                             |
| `src/core/`      | The rules, as functions on the state. `state.ts` (the file and the types), `files.ts` (private files), `lock.ts` (the lock), `errors.ts`, `reasons.ts` (reason texts), `ids.ts` (formats), `limits.ts` (all numbers), `agents.ts`, `pairing.ts`, `allow.ts`, `send.ts` (checks for a send), `outbox.ts`, `inbox.ts`, `turns.ts` (the loop limit), `ledger.ts` (idempotency), `text.ts`, `wire.ts` (exchange schemas), `exchange.ts` |
| `src/mcp/`       | The MCP side. `http.ts` is the endpoint and its checks. `tools.ts` has the tools and the approval flow. Also `confirmations.ts` (open questions), `unknown.ts` (unknown outcomes), `untrusted.ts` (the envelope) and `redact.ts` (paths out of error logs)                                                                                                                                                                          |
| `src/transport/` | How the calling machine reaches the other one: `spawn.ts` (one JSON exchange through a child process) and `index.ts` (ssh and the command transport)                                                                                                                                                                                                                                                                                |
| `src/service/`   | `serve.ts` (`courier serve`: the HTTP server and the loop) and `caller.ts` (the exchange loop)                                                                                                                                                                                                                                                                                                                                      |
| `src/cli/`       | `main.ts` (commands and exit codes), `commands.ts`, `args.ts` (a strict parser) and `exchange.ts` (the forced command)                                                                                                                                                                                                                                                                                                              |
| `docs/`          | These guides. `design.md` keeps the design decisions                                                                                                                                                                                                                                                                                                                                                                                |

## Checking a change

The project's test suites are maintained separately and are not part of this repository. In a
pull request, describe how you checked the change: what you ran, on which machines, and what
you saw. Never check a change against `~/.ssh`, `~/.config/agent-courier` or a Claude Code
session you care about.

## The command transport

`courier join ... --command '<JSON array>'` (not listed in `courier help`) uses a program in place of ssh: the first item is
the absolute path of the program, the others are its arguments. agent-courier writes the
request to its stdin and reads one JSON answer from its stdout, with no shell. You can use it to
run the other instance's forced command directly, or to wrap ssh in a different tool. Each pairing stores its transport in `state.json`.

## Add a tool

1. Put the rule in `src/core/` as a function on the state.
2. Register the tool in `src/mcp/tools.ts` with a `z.strictObject` input schema. Give ids a
   fixed format. Do not accept paths, URLs or the caller's agent name.
3. A tool that sends must use the approval flow (`guardedSend`) and an `idempotency_key`.
4. Document the tool, its schema, its result and its errors in `docs/mcp.md`.

## Commits

Write each commit message in English, on one line, in this form:

`Area: what changed for the person using it, and why: files`

The area is the part of the project, such as `README`, `Docs` or `MCP`. Do not use `fix:` or
`feat:` prefixes. Make one commit for each change.

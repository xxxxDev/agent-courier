# Contributing

Thanks for helping. agent-courier is a small project, so a short, focused change is the easiest to review.

## Before you start

- For a bug, open an issue with what you did, what you expected and what happened, plus the version (`courier --version`, or the commit you installed from) and, for both machines, the operating system, the Node version and the Claude Code version. Leave out tokens, keys and the text of real messages.
- For a larger change or a new feature, open an issue first so we can agree on the approach.
- For a security problem, follow [SECURITY.md](SECURITY.md) instead.

## Development

You need the tools in the README's [Requirements](README.md#requirements). mise installs Node (see `mise.toml`), and npm installs the pinned packages in `package-lock.json`. There is no build step: Node runs the TypeScript files directly.

```bash
npm ci
mise run check   # prettier --check, tsc and oxlint
```

Each change must pass `mise run check`. Without mise, use the npm scripts: `npm run fmt:check`, `npm run typecheck` and `npm run lint`. See [docs/development.md](docs/development.md) for the tasks, the source layout and how to add a tool.

The project's test suite is maintained separately and is not part of this repository. In your pull request, describe how you checked the change: what you ran, on which machines, and what you saw. Never check a change against `~/.ssh`, `~/.config/agent-courier` or a Claude Code session you care about.

## Guidelines

- Match the style of the code around your change.
- Use only erasable TypeScript syntax: no `enum`, no `namespace`, no parameter properties.
- A new MCP tool follows [Add a tool](docs/development.md#add-a-tool): a strict input schema, no paths, URLs or caller's agent name, the approval flow and an `idempotency_key` for a tool that sends, and its entry in [docs/mcp.md](docs/mcp.md).
- The README comes in English and Traditional Chinese. Change both, and keep them the same number of lines. The other documents and the command output are in English.
- Code comments are in English and say why, not what.

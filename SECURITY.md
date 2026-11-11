# Security

agent-courier passes messages between agent sessions (Claude Code and other MCP clients) on
machines that you control, over SSH. A paired machine is trusted as a whole, and approvals
guard against the model, not against code that runs as your user. See
[docs/security.md](docs/security.md) for the full security model: the network,
authentication, trust between machines, the secrets and the conditions of the design.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Email [support@v-ax.com](mailto:support@v-ax.com) instead. You can also use GitHub's **Report a vulnerability** button on this repository.

Include agent-courier, the version or commit, the relevant platform, minimal steps to reproduce, and the expected and observed results. Use fictional data where possible and redact sensitive information from errors or screenshots.

Do not send passwords, tokens (including `cour_` agent tokens), private keys (including a pairing's SSH key), account data, raw private logs, your `state.json` or the text of real messages. Include only the information needed to reproduce the problem.

For ordinary usage questions and non-sensitive bugs, use this repository's issue tracker.

// The `courier` command.

import { CourierError } from "../core/errors.ts";
import { dataDir, StateError, Store } from "../core/state.ts";
import { UnsafeFileError } from "../core/files.ts";
import { startService } from "../service/serve.ts";
import * as cmd from "./commands.ts";
import { FAILED, runExchange } from "./exchange.ts";
import { UUID } from "../core/ids.ts";
import { UsageError } from "./args.ts";

export const VERSION = "0.1.0";

export const HELP = `courier ${VERSION}: messages between Claude Code sessions on your own machines, over SSH

Usage:
  courier init --name <machine> [--port <port>]   create the data directory and state
  courier serve                                    run the MCP endpoint and the exchange loop
  courier exchange --pair <id>                     answer one exchange (the SSH forced command)

  courier agent add <name>                         make an agent token and print its claude mcp add line
  courier agent list
  courier agent remove <name>
  courier auto-approve <agent> on|off              send without asking the user (loop limit still asks)

  courier pair [--name <label>]                    make a one-time pairing code (answering machine)
  courier join <code> --name <label> --ssh-host <alias> --ssh-config <file>
                                                   pair with the machine that made the code
  courier enable <machine>                         let messages flow (both machines must enable)
  courier pause <machine>                          stop; what waited will not go
  courier revoke <machine>                         unpair; what waited will not go

  courier allow <agent> <machine>/<agent>          both machines must allow each other's agent
  courier disallow <agent> <machine>/<agent>
  courier status [--json]

Data directory: $COURIER_HOME, else ~/.config/agent-courier. Docs: docs/setup.md`;

const EXIT: Record<string, number> = {
  invalid: 2,
  "not-found": 3,
  conflict: 4,
  denied: 5,
  limit: 6,
  unreachable: 7,
};

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [command, ...rest] = argv;
  const store = new Store(dataDir(env));
  // The forced command answers before anything else is looked at, and only with JSON.
  // Its only form is `exchange --pair <id>`; anything else fails without reading stdin.
  if (command === "exchange") {
    if (rest.length !== 2 || rest[0] !== "--pair" || !UUID.test(rest[1]!)) {
      process.stdout.write(FAILED);
      return 2;
    }
    return runExchange(store, process.stdin, process.stdout, {
      pairId: rest[1]!,
    });
  }
  const ctx: cmd.Ctx = { store, out: (l) => console.log(l) };
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        console.log(HELP);
        return 0;
      case "--version":
      case "version":
        console.log(VERSION);
        return 0;
      case "init":
        cmd.init(ctx, rest);
        return 0;
      case "serve": {
        if (rest.length) throw new UsageError("usage: courier serve");
        const service = await startService({ store });
        console.log(
          `agent-courier ${store.read().name}: MCP on http://127.0.0.1:${service.port}/mcp`,
        );
        await new Promise<void>((resolve) => {
          const stop = () => resolve();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        await service.close();
        return 0;
      }
      case "agent":
        cmd.agent(ctx, rest);
        return 0;
      case "auto-approve":
        cmd.autoApprove(ctx, rest);
        return 0;
      case "pair":
        cmd.pair(ctx, rest);
        return 0;
      case "join":
        await cmd.join(ctx, rest);
        return 0;
      case "enable":
      case "pause":
      case "revoke":
        cmd.setPair(ctx, rest, command);
        return 0;
      case "allow":
        cmd.setAllow(ctx, rest, true);
        return 0;
      case "disallow":
        cmd.setAllow(ctx, rest, false);
        return 0;
      case "status":
        cmd.status(ctx, rest);
        return 0;
      default:
        throw new UsageError(`unknown command ${command}; see courier help`);
    }
  } catch (err) {
    if (err instanceof CourierError) {
      console.error(`courier: ${err.message}`);
      return EXIT[err.kind] ?? 1;
    }
    if (err instanceof StateError || err instanceof UnsafeFileError) {
      console.error(`courier: ${err.message}`);
      return 1;
    }
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(
        "courier: the port is in use: is courier serve already running?",
      );
      return 1;
    }
    throw err;
  }
}

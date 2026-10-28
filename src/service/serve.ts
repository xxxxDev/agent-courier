// `courier serve`: the MCP endpoint on 127.0.0.1 and the calling side's exchange loop.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Store } from "../core/state.ts";
import { Confirmations } from "../mcp/confirmations.ts";
import { createMcpHandler } from "../mcp/http.ts";
import { UnknownKeys } from "../mcp/unknown.ts";
import { transportCall } from "../transport/index.ts";
import { CallerLoop, type CallFor } from "./caller.ts";

export interface ServiceOptions {
  store: Store;
  /** Defaults to the port in the state; 0 picks a free one (tests). */
  port?: number;
  log?: (line: string) => void;
  callFor?: CallFor;
  poll?: readonly [number, number];
  confirmations?: Confirmations;
}

export interface Service {
  port: number;
  kick: () => void;
  close: () => Promise<void>;
}

export async function startService(opts: ServiceOptions): Promise<Service> {
  const { store } = opts;
  const log = opts.log ?? ((l: string) => console.log(l));
  const state = store.read();
  const loop = new CallerLoop(
    store,
    opts.callFor ?? ((t) => transportCall(t)),
    log,
    opts.poll,
  );
  let port = opts.port ?? state.port;
  const deps = {
    store,
    confirmations: opts.confirmations ?? new Confirmations(),
    unknown: new UnknownKeys(store.now),
    kick: () => loop.kick(),
    log,
  };
  // The handler needs the port for its Host check; with port 0 it is known after listen.
  let mcp: ReturnType<typeof createMcpHandler> | null = null;
  const server: Server = createServer((req, res) => {
    if (!mcp) {
      res.writeHead(503).end();
      return;
    }
    void mcp.handle(req, res);
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  mcp = createMcpHandler({ port, deps, log });
  loop.start();
  return {
    port,
    kick: () => loop.kick(),
    close: async () => {
      await loop.stop();
      await mcp?.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

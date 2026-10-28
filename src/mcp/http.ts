// The MCP endpoint: Streamable HTTP on 127.0.0.1 only, MCP 2026-07-28 only. Every request
// stands alone (no session) and is served by a fresh server built for the agent whose
// bearer token came with it. Before the SDK sees a request: the Host must be a loopback
// name of our port (DNS rebinding), no Origin (agents are not browsers), POST /mcp only,
// a known token, and a body within the limit.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createMcpHandler as createSdkHandler } from "@modelcontextprotocol/server";
import { agentByToken } from "../core/agents.ts";
import { MCP_BODY_BYTES } from "../core/limits.ts";
import { redact } from "./redact.ts";
import { buildServer, type ToolDeps } from "./tools.ts";

export interface McpHttpOptions {
  port: number;
  deps: ToolDeps;
  maxBody?: number;
  log?: (line: string) => void;
}

/** Not passed to the SDK: they describe the Node connection, or carry the token. */
const HOP_BY_HOP = new Set([
  "authorization",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function reply(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    "content-type": "application/json",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

async function readBody(
  req: IncomingMessage,
  max: number,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Host must name our port on a loopback name; the case of the name does not matter. */
export const hostAllowed = (
  host: string | undefined,
  port: number,
): boolean => {
  const h = host?.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
};

export function createMcpHandler(opts: McpHttpOptions) {
  const maxBody = opts.maxBody ?? MCP_BODY_BYTES;
  const log = opts.log ?? ((line: string) => console.log(line));
  // The agent travels with its own request (authInfo is passed through untouched), so
  // concurrent requests never see each other's agent. The token itself stays here.
  const sdk = createSdkHandler(
    (ctx) => {
      const agent = ctx.authInfo?.clientId;
      if (!agent) throw new Error("request without an agent");
      return buildServer(opts.deps, agent);
    },
    {
      legacy: "reject",
      maxRequestBodySize: maxBody,
      onerror: (err) => log(`[mcp] ${redact(err.message)}`),
    },
  );

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      if (!hostAllowed(req.headers.host, opts.port))
        return reply(res, 421, "misdirected request");
      if (req.headers.origin !== undefined)
        return reply(res, 403, "browser requests are not accepted");
      if (new URL(req.url ?? "/", "http://localhost").pathname !== "/mcp")
        return reply(res, 404, "not found");
      if (req.method !== "POST")
        return reply(res, 405, "method not allowed", { allow: "POST" });
      const bearer = /^Bearer ([^\s]+)$/.exec(
        req.headers.authorization ?? "",
      )?.[1];
      const agent = agentByToken(opts.deps.store.read(), bearer);
      if (!agent)
        return reply(res, 401, "unauthorized", {
          "www-authenticate": "Bearer",
        });

      const body = await readBody(req, maxBody);
      if (body === null)
        return reply(res, 413, "request body too large", {
          connection: "close",
        });
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (value !== undefined && !HOP_BY_HOP.has(name))
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const hangup = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) hangup.abort();
      });
      const request = new Request(`http://127.0.0.1:${opts.port}/mcp`, {
        method: "POST",
        headers,
        body,
        signal: hangup.signal,
      });
      const response = await sdk.fetch(request, {
        authInfo: { token: "", clientId: agent.name, scopes: [] },
      });
      response.headers.forEach((value, name) => res.setHeader(name, value));
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("cache-control", "no-store");
      res.writeHead(response.status);
      if (!response.body) return void res.end();
      await pipeline(
        Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
        res,
      );
    } catch (err) {
      if (res.destroyed) return;
      log(`[mcp] ${req.method} ${req.url}: ${redact((err as Error).message)}`);
      if (!res.headersSent) reply(res, 500, "internal error");
      else res.destroy();
    }
  }

  const close = () => sdk.close();
  return { handle, close };
}

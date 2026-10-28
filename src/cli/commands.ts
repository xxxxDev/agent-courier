// The CLI commands. Each one changes the state file under the lock, so they work whether
// or not `courier serve` runs; the service picks the change up on its next exchange.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addAgent,
  findAgent,
  removeAgent,
  setAutoApprove,
} from "../core/agents.ts";
import { allow, disallow } from "../core/allow.ts";
import { CourierError, invalid } from "../core/errors.ts";
import { unread } from "../core/inbox.ts";
import {
  addCallerPair,
  checkMachineName,
  createInvite,
  enablePair,
  findPair,
  flowing,
  openInvite,
  pausePair,
  revokePair,
} from "../core/pairing.ts";
import type { State, Store, Transport } from "../core/state.ts";
import { PairAnswer, V } from "../core/wire.ts";
import {
  checkTransport,
  type Call,
  namesDedicatedKey,
  readSshConfig,
  type SshConfigReader,
  sshConfigArgs,
  transportCall,
} from "../transport/index.ts";
import { checkAgentName } from "../core/agents.ts";
import { expectWords, flag, parseArgs, UsageError } from "./args.ts";

export interface Ctx {
  store: Store;
  out: (line: string) => void;
  /** For tests: how join reaches the other machine. */
  callFor?: (t: Transport) => Call;
  /** For tests: how join reads the effective ssh config (`ssh -G`). */
  sshConfig?: SshConfigReader;
}

/** A word for the shell that runs the forced command: quoted when it is not plain. */
const shellWord = (w: string) =>
  /^[A-Za-z0-9_./=:-]+$/.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`;

/**
 * The authorized_keys line for one pairing's key on this (answering) machine. The forced
 * command names the pairing, so the key can exchange for it and nothing else.
 */
export function authorizedKeysLine(
  pairId: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const bin = fileURLToPath(new URL("../../bin/courier.js", import.meta.url));
  const words = [
    ...(env.COURIER_HOME
      ? ["/usr/bin/env", `COURIER_HOME=${resolve(env.COURIER_HOME)}`]
      : []),
    process.execPath,
    bin,
    "exchange",
    "--pair",
    pairId,
  ];
  const command = words
    .map(shellWord)
    .join(" ")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return `command="${command}",restrict <public key of ${label}>`;
}

export function mcpAddLine(port: number, token: string): string {
  return `claude mcp add --transport http courier http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`;
}

export function init(ctx: Ctx, argv: string[]): void {
  const p = parseArgs(argv, { name: "value", port: "value" });
  expectWords(p, 0, "courier init --name <machine> [--port <port>]");
  const name = flag(p, "name");
  if (!name)
    throw new UsageError(
      "usage: courier init --name <machine> [--port <port>]",
    );
  const portText = flag(p, "port");
  const port = portText === undefined ? undefined : Number(portText);
  const { state, created } = ctx.store.init(checkMachineName(name), port);
  ctx.out(
    created
      ? `Initialized ${state.name} in ${ctx.store.dir} (MCP port ${state.port}).`
      : `Already initialized: ${state.name} in ${ctx.store.dir} (MCP port ${state.port}). Nothing changed.`,
  );
}

export function agent(ctx: Ctx, argv: string[]): void {
  const [sub, ...rest] = argv;
  const p = parseArgs(rest, {});
  const now = ctx.store.now();
  if (sub === "add") {
    const [name] = expectWords(p, 1, "courier agent add <name>");
    const { token, port } = ctx.store.update((s) => ({
      token: addAgent(s, checkAgentName(name!), now),
      port: s.port,
    }));
    ctx.out(
      `Added agent ${name}. Its token is shown once; it is not stored and cannot be shown again.`,
    );
    ctx.out("");
    ctx.out("Run this in the project where that Claude Code session works:");
    ctx.out("");
    ctx.out(`  ${mcpAddLine(port, token)}`);
    return;
  }
  if (sub === "remove") {
    const [name] = expectWords(p, 1, "courier agent remove <name>");
    ctx.store.update((s) => removeAgent(s, name!, now));
    ctx.out(
      `Removed agent ${name}. Its token no longer works; what it queued will not go (unsent, or in flight if already handed over).`,
    );
    return;
  }
  if (sub === "list") {
    expectWords(p, 0, "courier agent list");
    const s = ctx.store.read();
    if (!s.agents.length)
      ctx.out("No agents. Add one with: courier agent add <name>");
    for (const a of s.agents) ctx.out(agentLine(s, a.name));
    return;
  }
  throw new UsageError("usage: courier agent add|list|remove ...");
}

function agentLine(s: State, name: string): string {
  const a = findAgent(s, name);
  const allows = a.allow.map(
    (x) =>
      `${s.pairs.find((p) => p.pairId === x.pairId)?.name ?? "?"}/${x.agent}`,
  );
  return `${a.name}  auto-approve ${a.autoApprove ? "on" : "off"}  unread ${unread(s, a)}  allows ${allows.join(", ") || "(none)"}`;
}

export function autoApprove(ctx: Ctx, argv: string[]): void {
  const p = parseArgs(argv, {});
  const [name, value] = expectWords(
    p,
    2,
    "courier auto-approve <agent> on|off",
  );
  if (value !== "on" && value !== "off")
    throw new UsageError("usage: courier auto-approve <agent> on|off");
  ctx.store.update((s) => setAutoApprove(s, name!, value === "on"));
  ctx.out(
    value === "on"
      ? `${name} now sends without asking. It still stops after the loop limit and asks then.`
      : `${name} now asks before each message.`,
  );
}

export function pair(ctx: Ctx, argv: string[]): void {
  const p = parseArgs(argv, { name: "value" });
  expectWords(p, 0, "courier pair [--name <label for the other machine>]");
  const name = flag(p, "name") ?? null;
  const { code, expiresAt, pairId } = ctx.store.update((s) =>
    createInvite(s, name, ctx.store.now()),
  );
  ctx.out(`Pairing code: ${code}`);
  ctx.out(`It works once, until ${expiresAt}.`);
  ctx.out("");
  ctx.out(
    "1. Add this line to ~/.ssh/authorized_keys here, with the public key of the other machine's dedicated key:",
  );
  ctx.out("");
  ctx.out(`  ${authorizedKeysLine(pairId, name ?? "the other machine")}`);
  ctx.out("");
  ctx.out("2. Then, on the other machine, run:");
  ctx.out("");
  ctx.out(
    `  courier join ${code} --name <label for this machine> --ssh-host <alias> --ssh-config <file>`,
  );
}

const PAIR_REFUSED: Record<string, string> = {
  "no-open-code":
    "the other machine has no open pairing code: run courier pair there again",
  "wrong-code": "the code is wrong or has expired",
  "bad-request": "the other machine refused the pairing",
};

export async function join(ctx: Ctx, argv: string[]): Promise<void> {
  const usage =
    "courier join <code> --name <label> (--ssh-host <alias> --ssh-config <file> | --command <json array>)";
  const p = parseArgs(argv, {
    name: "value",
    "ssh-host": "value",
    "ssh-config": "value",
    command: "value",
  });
  const [code] = expectWords(p, 1, usage);
  const name = flag(p, "name");
  if (!name) throw new UsageError(`usage: ${usage}`);
  checkMachineName(name);
  const host = flag(p, "ssh-host");
  const config = flag(p, "ssh-config");
  const command = flag(p, "command");
  let transport: Transport;
  if (command !== undefined && host === undefined && config === undefined) {
    let argvJson: unknown;
    try {
      argvJson = JSON.parse(command);
    } catch {
      throw invalid("--command must be a JSON array of strings");
    }
    transport = checkTransport({ kind: "command", argv: argvJson as string[] });
  } else if (
    command === undefined &&
    host !== undefined &&
    config !== undefined
  ) {
    const ssh = checkTransport({ kind: "ssh", host, config: resolve(config) });
    if (ssh.kind !== "ssh") throw new UsageError(`usage: ${usage}`);
    let effective: string;
    try {
      effective = await (ctx.sshConfig ?? readSshConfig)(
        sshConfigArgs(ssh.config, ssh.host),
      );
    } catch {
      throw invalid(
        `could not read the ssh config for ${host} with ssh -G; check --ssh-config and --ssh-host`,
      );
    }
    if (!namesDedicatedKey(effective))
      throw invalid(
        `the ssh config names no IdentityFile for ${host} (or only a default ~/.ssh/id_* key): set IdentityFile to the dedicated key, so ssh offers only that key`,
      );
    transport = ssh;
  } else throw new UsageError(`usage: ${usage}`);

  const s = ctx.store.read();
  if (s.pairs.some((x) => x.name === name))
    throw invalid(
      `another pairing is named ${name}; choose another --name or revoke it first`,
    );
  const call = (ctx.callFor ?? ((t: Transport) => transportCall(t)))(transport);
  let raw: unknown;
  try {
    raw = await call({
      v: V,
      pair: { code: code!, machineId: s.machineId, name: s.name },
    });
  } catch (err) {
    throw new CourierError(
      "unreachable",
      `could not reach the other machine: ${(err as Error).message}`,
    );
  }
  const r = PairAnswer.safeParse(raw);
  if (!r.success)
    throw new CourierError(
      "unreachable",
      "the other machine's answer is not in the expected format",
    );
  if (!r.data.pair.ok)
    throw new CourierError(
      "denied",
      PAIR_REFUSED[r.data.pair.reason] ??
        "the other machine refused the pairing",
    );
  const answer = r.data.pair;
  ctx.store.update((st) =>
    addCallerPair(
      st,
      {
        pairId: answer.pairId,
        remoteMachineId: answer.machineId,
        remoteName: answer.name,
        name,
        transport,
      },
      ctx.store.now(),
    ),
  );
  ctx.out(`Paired with ${name}. Now enable the pairing on both machines:`);
  ctx.out(`  here:              courier enable ${name}`);
  ctx.out(
    `  on ${name}: courier enable <its label for this machine> (courier status there shows it)`,
  );
}

export function setPair(
  ctx: Ctx,
  argv: string[],
  to: "enable" | "pause" | "revoke",
): void {
  const p = parseArgs(argv, {});
  const [name] = expectWords(p, 1, `courier ${to} <machine>`);
  const now = ctx.store.now();
  ctx.store.update((s) => {
    if (to === "enable") enablePair(s, name!);
    else if (to === "pause") pausePair(s, name!, now);
    else revokePair(s, findPair(s, name!), "the pairing was revoked", now);
  });
  ctx.out(
    to === "enable"
      ? `Enabled ${name} here. Messages flow once the other machine has it enabled too.`
      : to === "pause"
        ? `Paused ${name}. What waited for it will not go (unsent, or in flight if already handed over).`
        : `Revoked ${name}. What waited for it will not go (unsent, or in flight if already handed over). Also remove its key line from ~/.ssh/authorized_keys on the answering machine.`,
  );
}

export function setAllow(ctx: Ctx, argv: string[], on: boolean): void {
  const p = parseArgs(argv, {});
  const verb = on ? "allow" : "disallow";
  const [local, target] = expectWords(
    p,
    2,
    `courier ${verb} <local agent> <machine>/<agent>`,
  );
  ctx.store.update((s) =>
    on ? allow(s, local!, target!) : disallow(s, local!, target!),
  );
  ctx.out(
    on
      ? `${local} may now write to and hear from ${target}. The other machine must allow it too.`
      : `${local} no longer hears from or writes to ${target}.`,
  );
}

export function status(ctx: Ctx, argv: string[]): void {
  const p = parseArgs(argv, { json: "switch" });
  expectWords(p, 0, "courier status [--json]");
  const s = ctx.store.read();
  const now = ctx.store.now();
  const view = {
    machine: s.name,
    machineId: s.machineId,
    port: s.port,
    openCode: openInvite(s, now)
      ? { expiresAt: new Date(openInvite(s, now)!.expires).toISOString() }
      : null,
    agents: s.agents.map((a) => ({
      name: a.name,
      autoApprove: a.autoApprove,
      unread: unread(s, a),
      queued: s.outbox.filter(
        (m) => m.agent === a.name && m.status === "queued",
      ).length,
      allows: a.allow.map(
        (x) =>
          `${s.pairs.find((q) => q.pairId === x.pairId)?.name ?? "?"}/${x.agent}`,
      ),
    })),
    pairs: s.pairs.map((q) => ({
      name: q.name,
      role: q.role,
      state: q.state,
      remote: q.remote,
      flowing: flowing(q),
      remoteName: q.remoteName,
      lastContact: q.lastContact,
      lastError: q.lastError,
      directory: q.directory,
      ...(q.transport?.kind === "ssh" ? { sshHost: q.transport.host } : {}),
      ...(q.role === "answerer"
        ? { authorizedKeys: authorizedKeysLine(q.pairId, q.name) }
        : {}),
    })),
  };
  if (p.flags.has("json")) {
    ctx.out(JSON.stringify(view, null, 2));
    return;
  }
  ctx.out(
    `${view.machine}  port ${view.port}${view.openCode ? `  open pairing code until ${view.openCode.expiresAt}` : ""}`,
  );
  ctx.out("");
  ctx.out("Agents:");
  if (!view.agents.length) ctx.out("  (none)");
  for (const a of view.agents)
    ctx.out(
      `  ${a.name}  auto-approve ${a.autoApprove ? "on" : "off"}  unread ${a.unread}  queued ${a.queued}  allows ${a.allows.join(", ") || "(none)"}`,
    );
  ctx.out("");
  ctx.out("Paired machines:");
  if (!view.pairs.length) ctx.out("  (none)");
  for (const q of view.pairs) {
    ctx.out(
      `  ${q.name}  ${q.role}  here ${q.state}  there ${q.remote.enabled ? "enabled" : "not enabled"}${q.remote.paused ? " (paused)" : ""}  ${q.flowing ? "flowing" : "not flowing"}`,
    );
    ctx.out(
      `    last contact ${q.lastContact ?? "never"}${q.lastError ? `  last error: ${q.lastError}` : ""}`,
    );
    for (const d of q.directory)
      ctx.out(`    ${q.name}/${d.agent} allows ${d.allows.join(", ")}`);
    if (q.authorizedKeys) ctx.out(`    authorized_keys: ${q.authorizedKeys}`);
  }
}

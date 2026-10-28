// How the calling side reaches the other machine. SSH by default: the dedicated key on
// the other machine runs only `courier exchange --pair <id>` (docs/setup.md). Whatever the
// config file says, the host key is pinned, only the configured key is offered, no control
// socket is shared, and nothing is forwarded. A fixed remote command follows the host: if
// the key was added without its forced command, the server runs that word (which fails)
// instead of a login shell that would read the request on stdin as a script.

import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { invalid } from "../core/errors.ts";
import type { Transport } from "../core/state.ts";
import { spawnJson, type SpawnOptions } from "./spawn.ts";

export type Call = (payload: unknown) => Promise<unknown>;

/** The remote command sent after the host. The forced command replaces it. */
export const REMOTE_COMMAND = "exchange";

/** Options given to ssh on every call, over anything in the config file. */
export const SSH_OPTIONS = [
  "BatchMode=yes",
  "StrictHostKeyChecking=yes",
  "IdentitiesOnly=yes",
  "IdentityAgent=none",
  "ControlMaster=no",
  "ControlPath=none",
  "RemoteCommand=none",
  "RequestTTY=no",
  "ClearAllForwardings=yes",
  "ForwardAgent=no",
  "ForwardX11=no",
  "PermitLocalCommand=no",
] as const;

/** A host alias from the SSH config file: no option, no user, no spaces. */
const SSH_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function sshArgs(config: string, host: string): string[] {
  return [
    "-F",
    config,
    "-T",
    ...SSH_OPTIONS.flatMap((o) => ["-o", o]),
    "--",
    host,
    REMOTE_COMMAND,
  ];
}

export function checkTransport(t: Transport): Transport {
  if (t.kind === "ssh") {
    if (!isAbsolute(t.config))
      throw invalid("--ssh-config must be an absolute path");
    if (!SSH_HOST.test(t.host))
      throw invalid(
        "--ssh-host must be a host alias from the SSH config file, such as courier-b",
      );
    return t;
  }
  if (
    !Array.isArray(t.argv) ||
    t.argv.length < 1 ||
    t.argv.length > 16 ||
    !t.argv.every((a) => typeof a === "string" && a.length <= 1024) ||
    !isAbsolute(t.argv[0]!)
  )
    throw invalid(
      "--command must be a JSON array whose first item is an absolute program path",
    );
  return t;
}

export function transportCall(t: Transport, opts: SpawnOptions = {}): Call {
  checkTransport(t);
  return t.kind === "ssh"
    ? (payload) => spawnJson("ssh", sshArgs(t.config, t.host), payload, opts)
    : (payload) => spawnJson(t.argv[0]!, t.argv.slice(1), payload, opts);
}

/** Runs `ssh <argv>` and returns its stdout; for `ssh -G`, which reads the config only. */
export type SshConfigReader = (argv: string[]) => Promise<string>;

export const readSshConfig: SshConfigReader = async (argv) =>
  (
    await promisify(execFile)("ssh", argv, {
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      encoding: "utf8",
    })
  ).stdout;

const DEFAULT_KEY =
  /(^|\/)\.ssh\/id_(rsa|dsa|ecdsa|ecdsa_sk|ed25519|ed25519_sk|xmss)$/;

/**
 * Whether the effective config (`ssh -G` output) names its own key for the host. With no
 * IdentityFile, ssh falls back to the default keys (~/.ssh/id_*), which are usually the
 * person's everyday keys, not the dedicated one.
 */
export function namesDedicatedKey(effective: string): boolean {
  const files = effective
    .split("\n")
    .map((l) => /^identityfile\s+(.+)$/i.exec(l.trim())?.[1])
    .filter((f): f is string => f !== undefined);
  return files.length > 0 && files.every((f) => !DEFAULT_KEY.test(f));
}

/** The arguments of `ssh -G` for this config file and host. */
export const sshConfigArgs = (config: string, host: string): string[] => [
  "-G",
  "-F",
  config,
  "--",
  host,
];

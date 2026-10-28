// A small strict parser: positional words and `--flag value` (or `--flag=value`). Unknown
// flags, missing values and extra words are errors, never ignored.

import { CourierError } from "../core/errors.ts";

export class UsageError extends CourierError {
  constructor(message: string) {
    super("invalid", message);
  }
}

export interface Parsed {
  words: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(
  argv: string[],
  known: Record<string, "value" | "switch">,
): Parsed {
  const words: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      words.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const kind = known[name];
    if (!kind) throw new UsageError(`unknown option --${name}`);
    if (flags.has(name)) throw new UsageError(`--${name} given twice`);
    if (kind === "switch") {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      flags.set(name, true);
      continue;
    }
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined || value === "")
      throw new UsageError(`--${name} needs a value`);
    flags.set(name, value);
  }
  return { words, flags };
}

export const flag = (p: Parsed, name: string): string | undefined => {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
};

export function expectWords(p: Parsed, n: number, usage: string): string[] {
  if (p.words.length !== n) throw new UsageError(`usage: ${usage}`);
  return p.words;
}

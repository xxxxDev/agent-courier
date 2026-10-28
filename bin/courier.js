#!/usr/bin/env node
// The `courier` command. Node runs the TypeScript sources directly (type stripping), so
// there is no build step; Node 22.18 or later.
import { main } from "../src/cli/main.ts";

process.exitCode = await main(process.argv.slice(2));

#!/usr/bin/env bun

import { loadHarnessConfig } from "@adaptive-harness/config";
import { runRunsCommand } from "./runs.ts";

const USAGE = `Usage:
  harness config validate [--config path]
  harness runs list [--config path] [--limit number] [--json]
  harness runs show <run-id> [--config path] [--events] [--after sequence] [--limit number] [--json]
  harness --help

Agent execution commands will be added in later milestones.`;

export async function runCli(args: string[]): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  if (args[0] === "runs") return runRunsCommand(args.slice(1));

  if (args[0] !== "config" || args[1] !== "validate") {
    console.error(`Unknown command: ${args.join(" ")}`);
    console.error(USAGE);
    return 2;
  }

  let configPath: string | undefined;
  for (let index = 2; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--config") {
      const value = args[++index];
      if (!value || value.startsWith("--") || configPath !== undefined) {
        console.error("--config requires one path");
        return 2;
      }
      configPath = value;
    } else if (arg?.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (!value || configPath !== undefined) {
        console.error("--config requires one path");
        return 2;
      }
      configPath = value;
    } else {
      console.error(`Unknown option: ${arg}`);
      return 2;
    }
  }

  try {
    const loaded = await loadHarnessConfig(configPath === undefined ? {} : { configPath });
    console.log(`Config valid: ${loaded.path}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Configuration validation failed");
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2));

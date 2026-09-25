#!/usr/bin/env bun

import { loadHarnessConfig } from "@adaptive-harness/config";
import {
  agentsCommand,
  approvalsCommand,
  type CommandContext,
  controlCommand,
  providersCommand,
  runCommand,
  watchCommand,
} from "./commands.ts";
import { runRunsCommand } from "./runs.ts";
import { openLocalRuntime } from "./runtime.ts";

const USAGE = `Usage:
  harness config validate [--config path]
  harness run <objective> [--config path] [--workspace path] [--decision-mode jev|deterministic] [--dry-run] [--json]
  harness runs list [--config path] [--limit number] [--json]
  harness runs show <run-id> [--config path] [--events] [--after sequence] [--limit number] [--json]
  harness runs watch <run-id> [--config path] [--after sequence] [--json]
  harness pause <run-id> [--config path] [--json]
  harness resume <run-id> [--config path] [--decision-mode jev|deterministic] [--json]
  harness cancel <run-id> [--config path] [--json]
  harness approvals answer <request-id> <answer> [--config path] [--decision-mode jev|deterministic] [--json]
  harness agents list [--config path] [--json]
  harness providers doctor [--config path] [--json]
  harness --help`;

export async function runCli(args: string[], overrides: Partial<CommandContext> = {}): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  const context: CommandContext = {
    openRuntime: overrides.openRuntime ?? ((request) => openLocalRuntime(request)),
    env: overrides.env ?? process.env,
  };
  const [command, ...rest] = args;
  if (command === "run") return runCommand(rest, context);
  if (command === "runs" && rest[0] === "watch") return watchCommand(rest.slice(1), context);
  if (command === "runs") return runRunsCommand(rest);
  if (command === "pause" || command === "resume" || command === "cancel")
    return controlCommand(command, rest, context);
  if (command === "approvals") return approvalsCommand(rest, context);
  if (command === "agents") return agentsCommand(rest, context);
  if (command === "providers") return providersCommand(rest, context);

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

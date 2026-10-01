import { loadHarnessConfig } from "@adaptive-harness/config";
import { SqliteRunReader } from "@adaptive-harness/runtime";

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function nonnegativeInteger(value: string | undefined): number | undefined {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

const DEFAULT_EVENT_PAGE_SIZE = 500;

/** Render run history without giving CLI handlers access to persistence or orchestration. */
export async function runRunsCommand(args: string[]): Promise<number> {
  const command = args[0];
  if (command !== "list" && command !== "show") {
    console.error(`Unknown runs command: ${command ?? ""}`);
    return 2;
  }

  let configPath: string | undefined;
  let limit: number | undefined;
  let afterSequence: number | undefined;
  let json = false;
  let events = false;
  const positional: string[] = [];

  for (let index = 1; index < args.length; index++) {
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
    } else if (arg === "--limit" || arg?.startsWith("--limit=")) {
      const value = arg === "--limit" ? args[++index] : arg.slice("--limit=".length);
      const parsedLimit = positiveInteger(value);
      if (limit !== undefined || parsedLimit === undefined) {
        console.error("--limit requires a positive integer");
        return 2;
      }
      limit = parsedLimit;
    } else if (arg === "--after" || arg?.startsWith("--after=")) {
      const value = arg === "--after" ? args[++index] : arg.slice("--after=".length);
      const parsedAfter = nonnegativeInteger(value);
      if (afterSequence !== undefined || parsedAfter === undefined) {
        console.error("--after requires a nonnegative integer");
        return 2;
      }
      afterSequence = parsedAfter;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--events") {
      events = true;
    } else if (arg?.startsWith("--")) {
      console.error(`Unknown option: ${arg}`);
      return 2;
    } else if (arg) {
      positional.push(arg);
    }
  }

  if (
    (command === "list" && (positional.length !== 0 || events || afterSequence !== undefined)) ||
    (command === "show" &&
      (positional.length !== 1 || (!events && (limit !== undefined || afterSequence !== undefined))))
  ) {
    console.error(
      command === "list"
        ? "Usage: harness runs list [--limit number] [--json]"
        : "Usage: harness runs show <run-id> [--events] [--after sequence] [--limit number] [--json]",
    );
    return 2;
  }

  let reader: SqliteRunReader | undefined;
  try {
    const loaded = await loadHarnessConfig(
      configPath === undefined ? { requireSecrets: false } : { configPath, requireSecrets: false },
    );
    for (const warning of loaded.warnings) console.error(`Warning: ${warning}`);
    reader = SqliteRunReader.open(loaded.config.storage.database);
    if (command === "list") {
      const runs = await reader.listRuns(limit === undefined ? {} : { limit });
      if (json) console.log(JSON.stringify(runs, null, 2));
      else if (runs.length === 0) console.log("No runs found.");
      else
        for (const run of runs)
          console.log(
            `${run.id}\t${run.status}${run.dryRun ? " (dry run)" : ""}\t${run.updatedAt}\t${run.objective.text.replace(/\s+/g, " ").slice(0, 120)}`,
          );
    } else {
      const runId = positional[0];
      if (!runId) return 2;
      const run = await reader.getRun(runId);
      const pageSize = limit ?? DEFAULT_EVENT_PAGE_SIZE;
      const runEvents = events ? await reader.listEvents(runId, afterSequence, pageSize) : undefined;
      const nextAfter = runEvents?.length === pageSize ? runEvents.at(-1)?.sequence : undefined;
      if (json) console.log(JSON.stringify(runEvents ? { run, events: runEvents, nextAfter } : { run }, null, 2));
      else {
        const budget = run.budget;
        console.log(
          `Run: ${run.id}\nStatus: ${run.status}${run.dryRun ? " (dry run)" : ""}\nObjective: ${run.objective.text}\nWorkspace: ${run.workspace}\nUpdated: ${run.updatedAt}\nBudget: ${budget.workerCalls} worker calls, ${budget.inputTokens} input / ${budget.outputTokens} output tokens${budget.unreportedWorkerCalls ? ` (${budget.unreportedWorkerCalls} ${budget.unreportedWorkerCalls === 1 ? "call" : "calls"} with unreported usage)` : ""}${budget.estimatedWorkerCalls ? ` (${budget.estimatedWorkerCalls} ${budget.estimatedWorkerCalls === 1 ? "call" : "calls"} estimated)` : ""}`,
        );
        if (runEvents)
          for (const event of runEvents) console.log(`#${event.sequence}\t${event.occurredAt}\t${event.payload.type}`);
        if (nextAfter !== undefined) console.log(`Continue with --after ${nextAfter}`);
      }
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Cannot read runs");
    return 1;
  } finally {
    reader?.close();
  }
}

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type ArmSummary, type EvalArm, type EvalProvider, type EvalReport, runEval } from "./runner.ts";
import { EVAL_TASKS } from "./tasks.ts";

const USAGE = `Usage: bun run eval [options]

Compares Jev decisions with the deterministic bypass on the same tasks and worker.
Workers are simulated unless live workers are enabled; Jev is the only real service called by default.

Options:
  --live-workers        Call the real worker CLI (also HARNESS_EVAL_LIVE_WORKERS=1)
  --provider <name>     Worker provider: codex (default) or cursor
  --tasks <ids>         Comma-separated task ids (default: all)
  --arms <arms>         Comma-separated arms: jev,deterministic (default: both)
  --out <path>          Results file (default: .harness/eval/eval-<timestamp>.json)
  --keep                Keep each task's workspace and database
  --list                List the task ids and exit
  -h, --help            Show this help
`;

function table(summaries: ArmSummary[]): string {
  const rows: Array<[string, (summary: ArmSummary) => string]> = [
    ["verified", (s) => `${s.verified}/${s.tasks}`],
    ["interventions", (s) => String(s.interventions)],
    ["worker calls", (s) => String(s.workerCalls)],
    ["review calls", (s) => String(s.reviewCalls)],
    ["retries", (s) => String(s.retries)],
    ["worker input tokens", (s) => String(s.inputTokens)],
    ["worker output tokens", (s) => String(s.outputTokens)],
    ["task kind matches", (s) => `${s.taskKindMatches}/${s.tasks}`],
    ["duration (s)", (s) => (s.durationMs / 1000).toFixed(1)],
  ];
  const header = ["metric", ...summaries.map((summary) => summary.arm)];
  const body = rows.map(([name, value]) => [name, ...summaries.map(value)]);
  const widths = header.map((_, column) => Math.max(...[header, ...body].map((row) => (row[column] ?? "").length)));
  return [header, ...body]
    .map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  "))
    .join("\n");
}

export function formatReport(report: EvalReport): string {
  const lines = [
    `Workers: ${report.liveWorkers ? `live ${report.provider}` : `simulated ${report.provider} (usage estimated)`}`,
    ...report.skipped.map((skip) => `Skipped ${skip.arm}: ${skip.reason}`),
    "",
    table(report.summaries),
  ];
  const failed = report.results.filter((result) => !result.verified);
  if (failed.length > 0) {
    lines.push("", "Unverified:");
    for (const result of failed) {
      lines.push(
        `  ${result.task} [${result.arm}]: ${result.status}${result.failureReason ? ` (${result.failureReason})` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function list<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of items) {
    if (!allowed.includes(item as T)) throw new Error(`Unknown ${name}: ${item}`);
  }
  return items as T[];
}

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "live-workers": { type: "boolean" },
      provider: { type: "string" },
      tasks: { type: "string" },
      arms: { type: "string" },
      out: { type: "string" },
      keep: { type: "boolean" },
      list: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.list) {
    for (const task of EVAL_TASKS) process.stdout.write(`${task.id}\t${task.objective}\n`);
    return 0;
  }
  const provider = (list(values.provider, ["codex", "cursor"] as const, "provider")?.[0] ?? "codex") as EvalProvider;
  const ids = list(
    values.tasks,
    EVAL_TASKS.map((task) => task.id),
    "task",
  );
  const arms = list(values.arms, ["jev", "deterministic"] as const, "arm") ?? (["jev", "deterministic"] as EvalArm[]);
  const liveWorkers = values["live-workers"] === true || env.HARNESS_EVAL_LIVE_WORKERS === "1";
  const report = await runEval({
    tasks: ids ? EVAL_TASKS.filter((task) => ids.includes(task.id)) : EVAL_TASKS,
    arms,
    provider,
    liveWorkers,
    env,
    keep: values.keep === true,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const out = resolve(values.out ?? `.harness/eval/eval-${report.startedAt.replaceAll(":", "-")}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${formatReport(report)}\n\nResults: ${out}\n`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
      process.exit(2);
    },
  );
}

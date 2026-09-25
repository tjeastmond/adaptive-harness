import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type HarnessConfig, HarnessConfigSchema } from "@adaptive-harness/config";
import type { DecisionMode, DecisionProvider, RunStatus, TaskKind, WorkerAdapter } from "@adaptive-harness/core";
import { JevHttpProvider } from "@adaptive-harness/decisions";
import { SqliteHarnessStore } from "@adaptive-harness/persistence";
import type { ApprovalRequest } from "@adaptive-harness/protocol";
import { createConfiguredWorkers, LocalHarnessRuntime } from "@adaptive-harness/runtime";
import { SimulatedWorker } from "./simulated-worker.ts";
import type { EvalTask, Fixture } from "./tasks.ts";

export type EvalArm = DecisionMode;
export type EvalProvider = "codex" | "cursor";

export interface EvalOptions {
  tasks: EvalTask[];
  arms: EvalArm[];
  provider: EvalProvider;
  /** Call the real worker CLI. Otherwise a simulated worker applies each task's scripted solution. */
  liveWorkers: boolean;
  env: Record<string, string | undefined>;
  /** Replaces the Jev HTTP client, for tests. */
  jev?: DecisionProvider;
  /** Keeps each task's workspace and database for inspection. */
  keep?: boolean;
  log?: (line: string) => void;
}

export interface TaskResult {
  task: string;
  arm: EvalArm;
  runId: string;
  status: RunStatus;
  failureReason?: string;
  /** The last verification passed and the run completed. */
  verified: boolean;
  /** Approvals the eval answered on the user's behalf. */
  interventions: number;
  workerCalls: number;
  reviewCalls: number;
  retries: number;
  decisions: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  taskKind?: TaskKind;
  expectedTaskKind: TaskKind;
  agent?: string;
  durationMs: number;
  workspace?: string;
}

export interface ArmSummary {
  arm: EvalArm;
  tasks: number;
  verified: number;
  interventions: number;
  workerCalls: number;
  reviewCalls: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  taskKindMatches: number;
  durationMs: number;
}

export interface EvalReport {
  startedAt: string;
  finishedAt: string;
  provider: EvalProvider;
  liveWorkers: boolean;
  /** Worker usage is estimated from text length when workers are simulated. */
  usageEstimated: boolean;
  skipped: Array<{ arm: EvalArm; reason: string }>;
  results: TaskResult[];
  summaries: ArmSummary[];
}

const PROVIDER_KINDS = { codex: "codex-cli", cursor: "cursor-cli" } as const;

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
}

/** Writes the fixture into a new temporary Git repository with one commit. */
export function createFixtureRepository(fixture: Fixture): string {
  const root = mkdtempSync(join(tmpdir(), "harness-eval-repo-"));
  for (const [path, content] of Object.entries(fixture)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, "init", "-q");
  git(root, "config", "user.email", "eval@example.com");
  git(root, "config", "user.name", "Harness Eval");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  return root;
}

/** Both the task config and the eval's own Jev client read their decision settings from here. */
const EVAL_DECISION = { jev: {}, fallback: { onUnavailable: "fail", onLowConfidence: "ask-user" } } as const;
/** Answering more approvals than this means the run is looping; the task is reported as `approval-limit`. */
const MAX_APPROVALS = 20;

export function evalConfig(task: EvalTask, provider: EvalProvider, database: string): HarnessConfig {
  return HarnessConfigSchema.parse({
    version: 1,
    project: { name: `eval-${task.id}` },
    storage: { database },
    decision: EVAL_DECISION,
    providers: { worker: { kind: PROVIDER_KINDS[provider] } },
    agents: {
      implementer: {
        provider: "worker",
        purpose: "implementation",
        instructions: "Make the requested change with the smallest correct edit. Do not commit.",
      },
      reviewer: {
        provider: "worker",
        purpose: "review",
        instructions: "Review the change against the objective and report concerns.",
        readOnly: true,
      },
    },
    routing: { defaultAgent: "implementer", complexAgent: "implementer", reviewerAgent: "reviewer" },
    limits: {},
    git: {},
    verification: { commands: task.verification },
    telemetry: {},
  });
}

/** Refuses every call: the deterministic arm must never reach Jev. */
const NO_JEV: DecisionProvider = {
  kind: "jev",
  preflight: async () => ({ ok: false, details: ["Jev is disabled for this arm"] }),
  evaluate: async () => {
    throw new Error("The deterministic arm called Jev");
  },
};

/** The answer a user would give: the task's clarification, or the choice the verification result supports. */
function answer(approval: ApprovalRequest, task: EvalTask, verified: boolean): string {
  const choices = approval.choices;
  if (!choices) return task.clarification;
  if (choices.includes("done")) {
    if (verified) return "done";
    return choices.includes("retry") ? "retry" : "fail";
  }
  return choices.find((choice) => choice !== "fail") ?? choices[0] ?? "fail";
}

async function allEvents(store: SqliteHarnessStore, runId: string) {
  const events = [];
  for (;;) {
    const page = await store.listEvents(runId, events.at(-1)?.sequence ?? 0, 1000);
    events.push(...page);
    if (page.length < 1000) return events;
  }
}

async function lastVerification(store: SqliteHarnessStore, runId: string): Promise<boolean> {
  const events = await allEvents(store, runId);
  const results = events.flatMap((event) =>
    event.payload.type === "verification.completed" ? [event.payload.result.ok] : [],
  );
  return results.at(-1) ?? false;
}

async function runTask(
  task: EvalTask,
  arm: EvalArm,
  options: EvalOptions,
  jev: DecisionProvider,
  secrets: Record<string, string>,
): Promise<TaskResult> {
  const workspace = createFixtureRepository(task.fixture);
  let dataDir: string | undefined;
  let store: SqliteHarnessStore | undefined;
  const started = performance.now();
  try {
    dataDir = mkdtempSync(join(tmpdir(), "harness-eval-db-"));
    const configPath = join(workspace, "harness.yaml");
    const config = evalConfig(task, options.provider, join(dataDir, "harness.sqlite"));
    store = new SqliteHarnessStore(config.storage.database, { redactValues: Object.values(secrets) });
    const workers: Record<string, WorkerAdapter> = options.liveWorkers
      ? createConfiguredWorkers(config)
      : { worker: new SimulatedWorker(PROVIDER_KINDS[options.provider], task.solution) };
    const runtime = new LocalHarnessRuntime({
      config: { path: configPath, config, hash: `eval-${task.id}` },
      store,
      jev: arm === "jev" ? jev : NO_JEV,
      workers,
      decisionMode: arm,
      decisionReason: "eval deterministic arm",
      environment: secrets,
    });
    const run = await runtime.createRun({
      objective: { text: task.objective, acceptanceCriteria: task.acceptanceCriteria },
      workspace,
      configPath,
    });
    await runtime.startRun(run.id);
    let interventions = 0;
    let approvalLimit = false;
    for (;;) {
      const [pending] = await store.listApprovals(run.id, "pending");
      if (!pending) break;
      if (interventions >= MAX_APPROVALS) {
        approvalLimit = true;
        break;
      }
      const reply = answer(pending, task, await lastVerification(store, run.id));
      options.log?.(`  ${task.id} [${arm}] approval (${pending.kind}): ${reply.slice(0, 60)}`);
      interventions += 1;
      await runtime.answerApproval(pending.id, reply);
    }
    const finished = await runtime.getRun(run.id);
    const tasks = await store.listTasks(run.id);
    const reads = new Set(tasks.filter((item) => item.access.mode === "read").map((item) => item.id));
    const calls = await store.listWorkerCalls(run.id);
    const events = await allEvents(store, run.id);
    const first = tasks[0];
    return {
      task: task.id,
      arm,
      runId: run.id,
      status: finished.status,
      ...(approvalLimit
        ? { failureReason: "approval-limit" }
        : finished.failureReason
          ? { failureReason: finished.failureReason }
          : {}),
      verified: finished.status === "completed" && (await lastVerification(store, run.id)),
      interventions,
      workerCalls: finished.budget.workerCalls,
      reviewCalls: calls.filter((call) => reads.has(call.taskId)).length,
      retries: events.filter((event) => event.payload.type === "policy.action" && event.payload.action === "retry")
        .length,
      decisions: (await store.listDecisions(run.id)).length,
      inputTokens: finished.budget.inputTokens,
      outputTokens: finished.budget.outputTokens,
      estimatedCostUsd: finished.budget.estimatedCostUsd,
      ...(first ? { taskKind: first.kind } : {}),
      expectedTaskKind: task.expectedTaskKind,
      ...(first?.assignedAgent ? { agent: first.assignedAgent } : {}),
      durationMs: Math.round(performance.now() - started),
      ...(options.keep ? { workspace } : {}),
    };
  } finally {
    store?.close();
    if (!options.keep) {
      rmSync(workspace, { recursive: true, force: true });
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

export function summarize(arm: EvalArm, results: TaskResult[]): ArmSummary {
  const mine = results.filter((result) => result.arm === arm);
  const total = (pick: (result: TaskResult) => number) => mine.reduce((sum, result) => sum + pick(result), 0);
  return {
    arm,
    tasks: mine.length,
    verified: mine.filter((result) => result.verified).length,
    interventions: total((result) => result.interventions),
    workerCalls: total((result) => result.workerCalls),
    reviewCalls: total((result) => result.reviewCalls),
    retries: total((result) => result.retries),
    inputTokens: total((result) => result.inputTokens),
    outputTokens: total((result) => result.outputTokens),
    estimatedCostUsd: total((result) => result.estimatedCostUsd),
    taskKindMatches: mine.filter((result) => result.taskKind === result.expectedTaskKind).length,
    durationMs: total((result) => result.durationMs),
  };
}

/** Runs every task once per arm with the same worker, so the arms differ only in who makes decisions. */
export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const defaults = HarnessConfigSchema.shape.decision.parse(EVAL_DECISION).jev;
  const apiKey = options.env[defaults.apiKeyEnv] ?? "";
  const secrets: Record<string, string> = apiKey ? { [defaults.apiKeyEnv]: apiKey } : {};
  const skipped: EvalReport["skipped"] = [];
  const arms = options.arms.filter((arm) => {
    if (arm !== "jev" || options.jev || apiKey) return true;
    skipped.push({ arm, reason: `Missing ${defaults.apiKeyEnv}; the Jev arm needs the Jev API key` });
    return false;
  });
  const jev =
    options.jev ??
    new JevHttpProvider({
      endpoint: defaults.baseUrl,
      apiKey,
      model: defaults.model,
      timeoutMs: defaults.timeoutMs,
      maxRetries: defaults.transientRetries,
    });
  const results: TaskResult[] = [];
  for (const task of options.tasks) {
    for (const arm of arms) {
      options.log?.(`${task.id} [${arm}]`);
      const result = await runTask(task, arm, options, jev, secrets);
      options.log?.(
        `  ${result.status}${result.verified ? ", verified" : ""}; ${result.workerCalls} worker calls, ${result.interventions} interventions`,
      );
      results.push(result);
    }
  }
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    provider: options.provider,
    liveWorkers: options.liveWorkers,
    usageEstimated: !options.liveWorkers,
    skipped,
    results,
    summaries: arms.map((arm) => summarize(arm, results)),
  };
}

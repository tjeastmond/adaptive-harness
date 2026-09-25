import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HarnessConfig, HarnessConfigSchema } from "@adaptive-harness/config";
import type {
  DecisionAnswer,
  DecisionProvider,
  DecisionRequest,
  Usage,
  WorkerAdapter,
  WorkerRequest,
  WorkerResult,
  WorkerStreamEvent,
} from "@adaptive-harness/core";
import { SqliteHarnessStore } from "@adaptive-harness/persistence";
import type { HarnessEvent } from "@adaptive-harness/protocol";
import {
  createConfiguredWorkers,
  LocalHarnessRuntime,
  type LocalRuntimeOptions,
  RuntimeUsageError,
} from "../src/runtime.ts";

const dirs: string[] = [];
const stores: SqliteHarnessStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(root: string, ...args: string[]): void {
  const process = Bun.spawnSync(["git", "-C", root, ...args]);
  if (process.exitCode !== 0) throw new Error(new TextDecoder().decode(process.stderr));
}

function repository(): string {
  const root = tempDir("harness-runtime-repo-");
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "initial");
  return root;
}

function config(
  limits: Partial<HarnessConfig["limits"]> = {},
  gitPolicy: Partial<HarnessConfig["git"]> = {},
): HarnessConfig {
  return HarnessConfigSchema.parse({
    version: 1,
    project: { name: "runtime-test" },
    storage: {},
    decision: { jev: {}, fallback: { onUnavailable: "fail", onLowConfidence: "ask-user" } },
    providers: { fake: { kind: "codex-cli" } },
    agents: {
      builder: { provider: "fake", purpose: "implementation", instructions: "Build it." },
      reviewer: { provider: "fake", purpose: "review", instructions: "Review it.", readOnly: true },
    },
    routing: { defaultAgent: "builder", complexAgent: "builder", reviewerAgent: "reviewer" },
    limits,
    git: gitPolicy,
    verification: {},
    telemetry: {},
  });
}

test("configured workers never see the Jev API key", async () => {
  const dir = tempDir("harness-worker-env-");
  const command = join(dir, "fake-agent");
  writeFileSync(command, '#!/bin/sh\nprintf "fake %s|%s" "$HARNESS_TEST_JEV_KEY" "$HARNESS_TEST_WORKER_KEY"\n', {
    mode: 0o755,
  });
  const configured = config();
  configured.decision.jev.apiKeyEnv = "HARNESS_TEST_JEV_KEY";
  configured.providers.fake = { ...configured.providers.fake, command } as HarnessConfig["providers"][string];
  process.env.HARNESS_TEST_JEV_KEY = "jev-secret";
  process.env.HARNESS_TEST_WORKER_KEY = "worker-auth";
  try {
    const preflight = await createConfiguredWorkers(configured).fake?.preflight();
    expect(preflight?.version).toBe("fake |worker-auth");
  } finally {
    delete process.env.HARNESS_TEST_JEV_KEY;
    delete process.env.HARNESS_TEST_WORKER_KEY;
  }
});

const choice = (value: string, confidence = 0.9): DecisionAnswer => ({
  type: "choice",
  choice: value,
  confidence,
  probabilities: { [value]: confidence },
});
const score = (value: number): DecisionAnswer => ({ type: "score", score: value, confidence: 0.9, probabilities: {} });
const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });

function routeAnswers(clear = 0.95): Record<string, DecisionAnswer> {
  return {
    task_kind: choice("implementation"),
    complexity: score(1),
    requirements_clear: noul(clear),
    external_research_needed: noul(0),
  };
}

type Completion = "done" | "retry" | "review" | "ask-user";
function completionAnswers(next: Completion): Record<string, DecisionAnswer> {
  if (next === "ask-user") {
    return {
      requirements_satisfied: noul(0.5),
      implementation_risk: score(1),
      more_work_useful: noul(0.5),
      independent_review_needed: noul(0),
      next_action: choice("ask-user"),
    };
  }
  return {
    requirements_satisfied: noul(next === "done" ? 0.95 : 0.2),
    implementation_risk: score(next === "review" ? 3 : 0),
    more_work_useful: noul(next === "retry" ? 0.5 : 0.1),
    independent_review_needed: noul(0),
    next_action: choice(next),
  };
}

/** Answers route decisions with `route` and completion decisions from `completions` in order. */
function jev(completions: Completion[], route = routeAnswers()) {
  const requests: DecisionRequest[] = [];
  const provider: DecisionProvider = {
    kind: "jev",
    preflight: async () => ({ ok: true, details: [] }),
    evaluate: async (request) => {
      requests.push(request);
      const isRoute = Object.hasOwn(request.questions, "task_kind");
      return {
        id: `decision-${crypto.randomUUID()}`,
        model: "jev-test",
        answers: isRoute ? route : completionAnswers(completions.shift() ?? "done"),
        usage: {},
        durationMs: 1,
        raw: {},
      };
    },
  };
  return { provider, requests };
}

interface Step {
  /** Files written into the workspace during the call. */
  write?: Record<string, string>;
  usage?: Usage;
  /** Advance the fake clock while the call runs. */
  advanceMs?: number;
  /** Wait until the runtime cancels the call. */
  block?: boolean;
}

class FakeWorker implements WorkerAdapter {
  readonly kind = "codex-cli" as const;
  readonly requests: WorkerRequest[] = [];
  readonly #waiting = new Map<string, () => void>();
  constructor(
    private readonly steps: Step[],
    private readonly clock?: { now: number },
  ) {}
  async preflight() {
    return { ok: true, details: [] };
  }
  async cancel(callId: string): Promise<void> {
    this.#waiting.get(callId)?.();
  }
  async execute(request: WorkerRequest, emit: (event: WorkerStreamEvent) => void | Promise<void>) {
    this.requests.push(request);
    const step = this.steps.shift() ?? {};
    const id = `call-${crypto.randomUUID()}`;
    const at = new Date().toISOString();
    const cancelled = new Promise<void>((done) => this.#waiting.set(id, done));
    await emit({ type: "session.started", callId: id, at });
    await emit({ type: "message", role: "assistant", text: "working", at });
    if (step.usage) await emit({ type: "usage", usage: step.usage, at });
    if (step.block) await cancelled;
    const status = step.block ? "cancelled" : "succeeded";
    for (const [path, content] of Object.entries(step.write ?? {}))
      writeFileSync(join(request.workspace, path), content);
    if (this.clock && step.advanceMs) this.clock.now += step.advanceMs;
    this.#waiting.delete(id);
    return {
      id,
      provider: "codex-cli",
      status,
      startedAt: at,
      finishedAt: new Date().toISOString(),
      durationMs: 1,
      exitCode: status === "succeeded" ? 0 : null,
      finalOutput: "done",
      usage: step.usage ?? { inputTokens: 10, outputTokens: 5 },
      rawEventCount: 1,
    } satisfies WorkerResult;
  }
}

function harness(
  options: {
    completions?: Completion[];
    route?: Record<string, DecisionAnswer>;
    steps?: Step[];
    limits?: Partial<HarnessConfig["limits"]>;
    git?: Partial<HarnessConfig["git"]>;
    clock?: { now: number };
    database?: string;
    store?: SqliteHarnessStore;
    owner?: string;
    workspace?: string;
  } = {},
) {
  const workspace = options.workspace ?? repository();
  const database = options.database ?? join(tempDir("harness-runtime-db-"), "harness.sqlite");
  const store = options.store ?? new SqliteHarnessStore(database);
  if (!options.store) stores.push(store);
  const decisions = jev(options.completions ?? ["done"], options.route);
  const worker = new FakeWorker(options.steps ?? [{ write: { "feature.txt": "feature\n" } }], options.clock);
  const clock = options.clock;
  const settings = config(options.limits, options.git);
  const runtimeOptions: LocalRuntimeOptions = {
    config: {
      path: join(workspace, "harness.yaml"),
      config: { ...settings, storage: { ...settings.storage, database } },
      hash: "config-hash",
    },
    store,
    jev: decisions.provider,
    workers: { fake: worker },
    pollIntervalMs: 10,
    leaseTimeoutMs: 1_000,
    ...(clock ? { now: () => clock.now } : {}),
    ...(options.owner ? { owner: options.owner } : {}),
  };
  const runtime = new LocalHarnessRuntime(runtimeOptions);
  const create = () =>
    runtime.createRun({
      objective: { text: "Add a feature file", acceptanceCriteria: ["feature.txt exists"] },
      workspace,
      configPath: join(workspace, "harness.yaml"),
    });
  return { runtime, store, worker, workspace, database, decisions, create };
}

async function eventTypes(store: SqliteHarnessStore, runId: string): Promise<HarnessEvent["type"][]> {
  const events = await store.listEvents(runId, 0, 1000);
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  return events.map((event) => event.payload.type);
}

async function statuses(store: SqliteHarnessStore, runId: string): Promise<string[]> {
  return (await store.listEvents(runId, 0, 1000)).flatMap((event) =>
    event.payload.type === "run.status-changed" ? [event.payload.to] : [],
  );
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(5);
  }
}

test("a run routes, works, verifies, and completes with an ordered event log", async () => {
  const { runtime, store, worker, create } = harness();
  const run = await create();
  expect(run.status).toBe("created");
  await runtime.startRun(run.id);

  const finished = await runtime.getRun(run.id);
  expect(finished.status).toBe("completed");
  expect(finished.completedAt).toBeDefined();
  expect(finished.budget).toMatchObject({ workerCalls: 1, inputTokens: 10, outputTokens: 5 });
  expect(worker.requests).toHaveLength(1);
  expect(worker.requests[0]?.task.access.mode).toBe("write");
  expect(await statuses(store, run.id)).toEqual(["routing", "running", "verifying", "completed"]);
  const types = await eventTypes(store, run.id);
  expect(types[0]).toBe("run.created");
  expect(types).toContain("worker.started");
  expect(types).toContain("verification.completed");
  expect(types.at(-1)).toBe("run.completed");
  expect((await store.listTasks(run.id)).map((task) => task.status)).toEqual(["completed"]);
  const chunks = await store.list(run.id);
  expect(chunks.map((chunk) => chunk.type)).toEqual(
    expect.arrayContaining(["plan", "agent-result", "test-result", "diff", "observation"]),
  );

  const streamed: string[] = [];
  for await (const event of runtime.subscribe(run.id)) streamed.push(event.payload.type);
  expect(streamed).toEqual(types);
  await expect(runtime.startRun(run.id)).rejects.toBeInstanceOf(RuntimeUsageError);
});

test("idempotent creation returns the existing run and config mismatches are rejected", async () => {
  const { runtime, workspace } = harness();
  const input = {
    objective: { text: "Once", acceptanceCriteria: [] },
    workspace,
    configPath: join(workspace, "harness.yaml"),
    idempotencyKey: "same-key",
  };
  const first = await runtime.createRun(input);
  expect((await runtime.createRun(input)).id).toBe(first.id);
  await expect(runtime.createRun({ ...input, configPath: join(workspace, "other.yaml") })).rejects.toThrow(
    "does not match",
  );
});

test("a dirty workspace fails preflight before any worker call", async () => {
  const { runtime, worker, workspace, create } = harness();
  writeFileSync(join(workspace, "README.md"), "dirty\n");
  const run = await create();
  await runtime.startRun(run.id);
  const failed = await runtime.getRun(run.id);
  expect(failed.status).toBe("failed");
  expect(worker.requests).toHaveLength(0);
});

test("a run database inside the workspace must be ignored by Git", async () => {
  const workspace = repository();
  const { runtime, worker, create } = harness({ workspace, database: join(workspace, ".harness", "harness.sqlite") });
  const run = await create();
  await runtime.startRun(run.id);
  expect((await runtime.getRun(run.id)).status).toBe("failed");
  expect(worker.requests).toHaveLength(0);
  const events: HarnessEvent[] = [];
  for await (const event of runtime.subscribe(run.id)) events.push(event.payload);
  expect(events.find((event) => event.type === "run.failed")).toMatchObject({
    error: expect.stringContaining("not ignored"),
  });
});

test("review uses a read-only agent and completes after the review", async () => {
  const { runtime, store, worker, create } = harness({
    completions: ["review", "done"],
    steps: [{ write: { "feature.txt": "feature\n" } }, {}],
  });
  const run = await create();
  await runtime.startRun(run.id);
  expect((await runtime.getRun(run.id)).status).toBe("completed");
  expect(worker.requests.map((request) => [request.agentName, request.task.access.mode])).toEqual([
    ["builder", "write"],
    ["reviewer", "read"],
  ]);
  expect(await statuses(store, run.id)).toEqual([
    "routing",
    "running",
    "verifying",
    "reviewing",
    "verifying",
    "completed",
  ]);
  const [implementation, review] = await store.listTasks(run.id);
  expect(review).toMatchObject({ kind: "review", access: { mode: "read" }, parentTaskId: implementation?.id });
});

test("a read-only reviewer that changes the workspace fails the run", async () => {
  const { runtime, create } = harness({
    completions: ["review"],
    steps: [{ write: { "feature.txt": "feature\n" } }, { write: { "sneaky.txt": "edit\n" } }],
  });
  const run = await create();
  await runtime.startRun(run.id);
  const failed = await runtime.getRun(run.id);
  expect(failed.status).toBe("failed");
  expect(failed.failureReason).toContain("Read-only worker changed the workspace: sneaky.txt");
});

test("a read-only reviewer edit to an already dirty file fails the run", async () => {
  const workspace = repository();
  writeFileSync(join(workspace, "README.md"), "user edit before the run\n");
  const { runtime, create } = harness({
    workspace,
    git: { requireClean: false },
    completions: ["review"],
    steps: [{ write: { "feature.txt": "feature\n" } }, { write: { "README.md": "reviewer edit\n" } }],
  });
  const run = await create();
  await runtime.startRun(run.id);
  const failed = await runtime.getRun(run.id);
  expect(failed.status).toBe("failed");
  expect(failed.failureReason).toContain("Read-only worker changed the workspace: README.md");
});

test("retries stop at the per-task retry limit", async () => {
  const { runtime, store, worker, create } = harness({
    completions: ["retry", "retry", "retry"],
    steps: [{}, {}, {}],
    limits: { maxRetriesPerTask: 1 },
  });
  const run = await create();
  await runtime.startRun(run.id);
  const failed = await runtime.getRun(run.id);
  expect(failed.status).toBe("failed");
  expect(failed.failureReason).toContain("retry-limit");
  expect(worker.requests).toHaveLength(2);
  expect((await store.listTasks(run.id)).map((task) => task.attempt)).toEqual([1, 2]);
});

test("step and worker-call limits stop further work", async () => {
  for (const [limits, reason] of [
    [{ maxSteps: 3 }, "step-limit"],
    [{ maxWorkerCalls: 1 }, "worker-call-limit"],
  ] as const) {
    const { runtime, worker, create } = harness({ completions: ["retry"], limits });
    const run = await create();
    await runtime.startRun(run.id);
    const failed = await runtime.getRun(run.id);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toContain(reason);
    expect(worker.requests).toHaveLength(1);
  }
});

test("streamed token and cost usage beyond the budget cancels the call and fails the run", async () => {
  for (const [usage, limits, reason] of [
    [{ inputTokens: 500 }, { maxInputTokens: 100 }, "token-limit"],
    [{ estimatedCostUsd: 2 }, { maxCostUsd: 1 }, "cost-limit"],
  ] as const) {
    const { runtime, store, create } = harness({ steps: [{ usage, block: true }], limits });
    const run = await create();
    await runtime.startRun(run.id);
    const failed = await runtime.getRun(run.id);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe(reason);
    const [call] = await store.listWorkerCalls(run.id);
    expect(call?.result.status).toBe("cancelled");
  }
});

test("active time beyond the time limit stops the run and paused time is not charged", async () => {
  const clock = { now: Date.parse("2026-09-25T12:00:00.000Z") };
  const { runtime, create } = harness({
    clock,
    completions: ["retry"],
    steps: [{ advanceMs: 2_000 }],
    limits: { maxElapsedMs: 1_000 },
  });
  const run = await create();
  await runtime.startRun(run.id);
  const failed = await runtime.getRun(run.id);
  expect(failed.status).toBe("failed");
  expect(failed.failureReason).toContain("time-limit");
  expect(failed.budget.elapsedMs).toBeGreaterThanOrEqual(2_000);

  const idle = harness({ clock, completions: ["ask-user", "done"], limits: { maxElapsedMs: 1_000 } });
  const waiting = await idle.create();
  await idle.runtime.startRun(waiting.id);
  const [approval] = await idle.store.listApprovals(waiting.id, "pending");
  clock.now += 10_000;
  await idle.runtime.answerApproval(approval?.id ?? "", "done");
  const done = await idle.runtime.getRun(waiting.id);
  expect(done.status).toBe("completed");
  expect(done.budget.elapsedMs).toBeLessThan(1_000);
});

test("subscriptions to a paused run end after an abort once persisted events are delivered", async () => {
  const { runtime, create } = harness({ completions: ["ask-user"], steps: [{}] });
  const run = await create();
  const controller = new AbortController();
  const seen: HarnessEvent["type"][] = [];
  const watching = (async () => {
    for await (const event of runtime.subscribe(run.id, 0, { signal: controller.signal }))
      seen.push(event.payload.type);
  })();
  await runtime.startRun(run.id);
  controller.abort();
  await watching;
  expect(seen[0]).toBe("run.created");
  expect(seen.at(-1)).toBe("run.paused");
  expect(seen).toContain("approval.requested");
});

test("completion approvals pause the run and resume on a valid answer", async () => {
  const { runtime, store, worker, create } = harness({ completions: ["ask-user", "done"], steps: [{}, {}] });
  const run = await create();
  await runtime.startRun(run.id);
  expect((await runtime.getRun(run.id)).status).toBe("paused");
  const [approval] = await store.listApprovals(run.id, "pending");
  expect(approval?.choices).toEqual(["retry", "review", "done", "fail"]);
  await expect(runtime.resumeRun(run.id)).rejects.toThrow("waiting for approval");
  await expect(runtime.answerApproval(approval?.id ?? "", "maybe")).rejects.toThrow("must be one of");

  await runtime.answerApproval(approval?.id ?? "", "retry");
  expect((await runtime.getRun(run.id)).status).toBe("completed");
  expect(worker.requests).toHaveLength(2);
  expect((await store.getApproval(approval?.id ?? ""))?.status).toBe("answered");
  await expect(runtime.answerApproval(approval?.id ?? "", "done")).rejects.toThrow("is answered");
  expect((await store.list(run.id)).some((chunk) => chunk.source === "approval")).toBe(true);
});

test("an approval requested with an exhausted budget offers only choices that start no work", async () => {
  const { runtime, store, create } = harness({ completions: ["ask-user"], limits: { maxWorkerCalls: 1 } });
  const run = await create();
  await runtime.startRun(run.id);
  const [approval] = await store.listApprovals(run.id, "pending");
  expect(approval?.choices).toEqual(["done", "fail"]);
  expect(approval?.prompt).toContain("worker-call-limit");
});

test("concurrent calls for one run in the same runtime report local activity", async () => {
  const { runtime, store, create } = harness({ completions: ["ask-user"] });
  const run = await create();
  await runtime.startRun(run.id);
  const [approval] = await store.listApprovals(run.id, "pending");
  const results = await Promise.allSettled([
    runtime.answerApproval(approval?.id ?? "", "fail"),
    runtime.answerApproval(approval?.id ?? "", "fail"),
  ]);
  const rejected = results.filter((result) => result.status === "rejected");
  expect(rejected).toHaveLength(1);
  expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain("already active in this runtime");
  expect((await runtime.getRun(run.id)).status).toBe("failed");
});

test("unclear requirements ask for clarification before any worker call", async () => {
  const { runtime, store, worker, create } = harness({ route: routeAnswers(0.1) });
  const run = await create();
  await runtime.startRun(run.id);
  expect((await runtime.getRun(run.id)).status).toBe("paused");
  expect(worker.requests).toHaveLength(0);
  const [approval] = await store.listApprovals(run.id, "pending");
  expect(approval).toMatchObject({ kind: "clarification" });
  expect(approval?.choices).toBeUndefined();

  await runtime.answerApproval(approval?.id ?? "", "Write feature.txt with one line.");
  expect((await runtime.getRun(run.id)).status).toBe("completed");
  expect(worker.requests[0]?.instructions).toContain("Write feature.txt with one line.");
});

test("cancelling during a worker call stops the call and ends the run as cancelled", async () => {
  const { runtime, store, worker, create } = harness({ steps: [{ block: true }] });
  const run = await create();
  const started = runtime.startRun(run.id);
  await waitFor(() => worker.requests.length === 1);
  await runtime.cancelRun(run.id);
  await started;
  expect((await runtime.getRun(run.id)).status).toBe("cancelled");
  expect((await eventTypes(store, run.id)).at(-1)).toBe("run.cancelled");
  await expect(runtime.pauseRun(run.id)).rejects.toThrow("is cancelled");
  await runtime.cancelRun(run.id);
});

test("cancelling a run that waits for approval cancels the approval", async () => {
  const { runtime, store, create } = harness({ completions: ["ask-user"] });
  const run = await create();
  await runtime.startRun(run.id);
  const [approval] = await store.listApprovals(run.id, "pending");
  await runtime.cancelRun(run.id);
  expect((await runtime.getRun(run.id)).status).toBe("cancelled");
  expect((await store.getApproval(approval?.id ?? ""))?.status).toBe("cancelled");
});

test("pausing during a worker call keeps its result and resumes at verification", async () => {
  const { runtime, store, worker, create } = harness({ steps: [{ block: true, write: { "feature.txt": "x\n" } }] });
  const run = await create();
  const started = runtime.startRun(run.id);
  await waitFor(() => worker.requests.length === 1);
  await runtime.pauseRun(run.id);
  await started;
  expect((await runtime.getRun(run.id)).status).toBe("paused");
  expect(await store.listWorkerCalls(run.id)).toHaveLength(1);

  await runtime.resumeRun(run.id);
  expect((await runtime.getRun(run.id)).status).toBe("completed");
  expect(worker.requests).toHaveLength(1);
  expect(await statuses(store, run.id)).toEqual(["routing", "running", "paused", "verifying", "completed"]);
});

test("changes made outside the harness between worker calls fail the run", async () => {
  const { runtime, store, workspace, worker, create } = harness({ completions: ["ask-user"], steps: [{}, {}] });
  const run = await create();
  await runtime.startRun(run.id);
  writeFileSync(join(workspace, "README.md"), "edited by someone else\n");
  const [approval] = await store.listApprovals(run.id, "pending");
  await runtime.answerApproval(approval?.id ?? "", "retry");
  const failed = await runtime.getRun(run.id);
  expect(failed.status).toBe("failed");
  expect(failed.failureReason).toContain("Workspace changed outside the harness: README.md");
  expect(worker.requests).toHaveLength(1);
});

/** Wraps a store so that every run commit fails once `dead` is set, as if the process had exited. */
function mortal(store: SqliteHarnessStore, dieWhen: (events: HarnessEvent["type"][]) => boolean) {
  let dead = false;
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "commitRun") {
        return async (...args: Parameters<SqliteHarnessStore["commitRun"]>) => {
          if (!dead && dieWhen((args[2].events ?? []).map((event) => event.payload.type))) dead = true;
          if (dead) throw new Error("process exited");
          return target.commitRun(...args);
        };
      }
      if (property === "releaseRunLease") return async () => undefined;
      return value.bind(target);
    },
  });
}

test("a restart recovers an interrupted call without executing it again", async () => {
  const database = join(tempDir("harness-runtime-db-"), "harness.sqlite");
  const store = new SqliteHarnessStore(database);
  stores.push(store);
  const clock = { now: Date.parse("2026-09-25T12:00:00.000Z") };
  const first = harness({
    database,
    clock,
    store: mortal(store, (events) => events.includes("worker.started")),
    owner: "first",
  });
  const run = await first.create();
  await expect(first.runtime.startRun(run.id)).rejects.toThrow("process exited");
  await waitFor(() => first.worker.requests.length === 1);
  await Bun.sleep(20);
  expect((await store.getRun(run.id))?.status).toBe("running");

  clock.now += 5_000;
  const second = harness({ database, clock, store, owner: "second", workspace: first.workspace });
  expect(await second.runtime.recoverInterruptedRuns()).toEqual([run.id]);
  expect((await store.getRun(run.id))?.status).toBe("paused");
  await second.runtime.resumeRun(run.id);

  expect((await store.getRun(run.id))?.status).toBe("completed");
  expect(second.worker.requests).toHaveLength(0);
  const [call] = await store.listWorkerCalls(run.id);
  expect(call?.result).toMatchObject({ status: "failed", error: expect.stringContaining("not executed again") });
  expect((await store.getRun(run.id))?.budget.workerCalls).toBe(1);
});

test("a restart after a finished call reuses its saved result", async () => {
  const database = join(tempDir("harness-runtime-db-"), "harness.sqlite");
  const store = new SqliteHarnessStore(database);
  stores.push(store);
  const clock = { now: Date.parse("2026-09-25T12:00:00.000Z") };
  const first = harness({
    database,
    clock,
    store: mortal(store, (events) => events.includes("worker.completed")),
    owner: "first",
  });
  const run = await first.create();
  await expect(first.runtime.startRun(run.id)).rejects.toThrow("process exited");
  await waitFor(async () => (await store.listWorkerCalls(run.id)).length === 1);
  await Bun.sleep(20);

  clock.now += 5_000;
  const second = harness({ database, clock, store, owner: "second", workspace: first.workspace });
  expect(await second.runtime.recoverInterruptedRuns()).toEqual([run.id]);
  await second.runtime.resumeRun(run.id);

  const finished = await store.getRun(run.id);
  expect(finished?.status).toBe("completed");
  expect(first.worker.requests).toHaveLength(1);
  expect(second.worker.requests).toHaveLength(0);
  const calls = await store.listWorkerCalls(run.id);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.result.status).toBe("succeeded");
  expect(finished?.budget.inputTokens).toBe(10);
});

test("a restart after verification evidence was written does not duplicate it", async () => {
  const database = join(tempDir("harness-runtime-db-"), "harness.sqlite");
  const store = new SqliteHarnessStore(database);
  stores.push(store);
  const clock = { now: Date.parse("2026-09-25T12:00:00.000Z") };
  const first = harness({
    database,
    clock,
    store: mortal(store, (events) => events.includes("verification.completed")),
    owner: "first",
  });
  const run = await first.create();
  await expect(first.runtime.startRun(run.id)).rejects.toThrow("process exited");
  await waitFor(async () => (await store.list(run.id, { types: ["diff"] })).length === 1);
  await Bun.sleep(20);

  clock.now += 5_000;
  const second = harness({ database, clock, store, owner: "second", workspace: first.workspace });
  expect(await second.runtime.recoverInterruptedRuns()).toEqual([run.id]);
  await second.runtime.resumeRun(run.id);

  expect((await store.getRun(run.id))?.status).toBe("completed");
  expect(second.worker.requests).toHaveLength(0);
  expect(await store.list(run.id, { types: ["test-result"] })).toHaveLength(1);
  const diffs = await store.list(run.id, { types: ["diff"] });
  expect(diffs).toHaveLength(1);
  const diff = diffs[0]?.content as { workerChanges: { path: string }[] };
  expect(diff.workerChanges.map((change) => change.path)).toEqual(["feature.txt"]);
});

test("a live runtime's lease prevents another runtime from recovering its run", async () => {
  const database = join(tempDir("harness-runtime-db-"), "harness.sqlite");
  const first = harness({ database, steps: [{ block: true }], owner: "first" });
  const run = await first.create();
  const started = first.runtime.startRun(run.id);
  await waitFor(() => first.worker.requests.length === 1);
  const second = harness({ database, owner: "second", workspace: first.workspace });
  expect(await second.runtime.recoverInterruptedRuns()).toEqual([]);
  // A control request from another runtime is applied by the lease holder.
  await second.runtime.cancelRun(run.id);
  await started;
  expect((await first.runtime.getRun(run.id)).status).toBe("cancelled");
});

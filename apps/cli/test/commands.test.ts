import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DecisionAnswer,
  DecisionProvider,
  WorkerAdapter,
  WorkerRequest,
  WorkerResult,
  WorkerStreamEvent,
} from "@adaptive-harness/core";
import { runCli } from "../src/cli.ts";
import { openLocalRuntime, type RuntimeOverrides } from "../src/runtime.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** A config directory with a clean repository workspace and a run database outside it. */
function fixture(): { root: string; configPath: string; workspace: string } {
  const root = mkdtempSync("/private/tmp/harness-cli-commands-");
  dirs.push(root);
  const workspace = join(root, "repo");
  Bun.spawnSync(["mkdir", workspace]);
  git(workspace, "init", "-q");
  git(workspace, "config", "user.email", "test@example.com");
  git(workspace, "config", "user.name", "Test");
  writeFileSync(join(workspace, "README.md"), "fixture\n");
  git(workspace, "add", "README.md");
  git(workspace, "commit", "-qm", "initial");
  const configPath = join(root, "harness.yaml");
  writeFileSync(
    configPath,
    `version: 1
project:
  name: cli-test
  workspace: repo
storage:
  database: db/harness.sqlite
decision:
  jev: {}
  fallback:
    onUnavailable: fail
    onLowConfidence: ask-user
providers:
  fake:
    kind: codex-cli
agents:
  builder:
    provider: fake
    purpose: implementation
    instructions: Build it.
  reviewer:
    provider: fake
    purpose: review
    readOnly: true
    instructions: Review it.
routing:
  defaultAgent: builder
  complexAgent: builder
  reviewerAgent: reviewer
limits: {}
git: {}
verification:
  commands: []
telemetry: {}
`,
  );
  return { root, configPath, workspace };
}

const choice = (value: string): DecisionAnswer => ({
  type: "choice",
  choice: value,
  confidence: 0.9,
  probabilities: { [value]: 0.9 },
});
const score = (value: number): DecisionAnswer => ({ type: "score", score: value, confidence: 0.9, probabilities: {} });
const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });

/** Routes every run to implementation, then answers completion decisions from `completions` in order. */
function fakeJev(completions: Array<"done" | "ask-user">): DecisionProvider {
  return {
    kind: "jev",
    preflight: async () => ({ ok: true, details: [] }),
    evaluate: async (request) => {
      const route = Object.hasOwn(request.questions, "task_kind");
      const next = route ? "done" : (completions.shift() ?? "done");
      return {
        id: `decision-${crypto.randomUUID()}`,
        model: "jev-test",
        answers: route
          ? {
              task_kind: choice("implementation"),
              complexity: score(1),
              requirements_clear: noul(0.95),
              external_research_needed: noul(0),
            }
          : {
              requirements_satisfied: noul(next === "done" ? 0.95 : 0.5),
              implementation_risk: score(1),
              more_work_useful: noul(next === "done" ? 0.1 : 0.5),
              independent_review_needed: noul(0),
              next_action: choice(next),
            },
        usage: {},
        durationMs: 1,
        raw: {},
      };
    },
  };
}

class FakeWorker implements WorkerAdapter {
  readonly kind = "codex-cli" as const;
  readonly requests: WorkerRequest[] = [];
  async preflight() {
    return { ok: true, version: "fake 1.0", details: [] };
  }
  async cancel(): Promise<void> {}
  async execute(request: WorkerRequest, emit: (event: WorkerStreamEvent) => void | Promise<void>) {
    this.requests.push(request);
    const at = new Date().toISOString();
    const id = `call-${crypto.randomUUID()}`;
    await emit({ type: "session.started", callId: id, at });
    await emit({ type: "message", role: "assistant", text: "writing the feature", at });
    if (!request.readOnly) writeFileSync(join(request.workspace, `feature-${this.requests.length}.txt`), "feature\n");
    return {
      id,
      provider: "codex-cli",
      status: "succeeded",
      startedAt: at,
      finishedAt: at,
      durationMs: 1,
      exitCode: 0,
      finalOutput: "done",
      usage: { inputTokens: 10, outputTokens: 5 },
      rawEventCount: 1,
    } satisfies WorkerResult;
  }
}

/** Runs the CLI in-process and captures what it prints. */
async function cli(args: string[], overrides: RuntimeOverrides = {}, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
  const error = spyOn(console, "error").mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));
  try {
    const code = await runCli(args, {
      env,
      openRuntime: (request) => openLocalRuntime(request, { pollIntervalMs: 10, ...overrides }),
    });
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

const runId = (stdout: string) => /Run (run-[\w-]+)/.exec(stdout)?.[1] ?? "";

test("run streams events and reports a completed run", async () => {
  const { configPath, workspace } = fixture();
  const worker = new FakeWorker();
  const result = await cli(["run", "Add a feature file", "--config", configPath], {
    jev: fakeJev(["done"]),
    workers: { fake: worker },
  });
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("decision mode: jev");
  expect(result.stdout).toContain("worker: writing the feature");
  expect(result.stdout).toMatch(/Run run-[\w-]+: completed/);
  expect(worker.requests[0]?.workspace).toBe(workspace);

  const watched = await cli(["runs", "watch", runId(result.stdout), "--config", configPath, "--json"]);
  const types = watched.stdout.split("\n").map((line) => JSON.parse(line).payload.type);
  expect(types[0]).toBe("run.created");
  expect(types.at(-1)).toBe("run.completed");
});

test("run pauses for an approval that approvals answer resolves", async () => {
  const { configPath } = fixture();
  const overrides = { jev: fakeJev(["ask-user", "done"]), workers: { fake: new FakeWorker() } };
  const started = await cli(["run", "Add a feature file", "--config", configPath, "--json"], overrides);
  expect(started.code).toBe(0);
  const report = JSON.parse(started.stdout);
  expect(report.run.status).toBe("paused");
  expect(report.approval.choices).toContain("done");

  expect((await cli(["resume", report.run.id, "--config", configPath], overrides)).stderr).toContain(
    "waiting for approval",
  );
  expect(
    (await cli(["approvals", "answer", report.approval.id, "maybe", "--config", configPath], overrides)).code,
  ).toBe(1);
  const answered = await cli(["approvals", "answer", report.approval.id, "done", "--config", configPath], overrides);
  expect(answered.code).toBe(0);
  expect(answered.stdout).toContain("approval answered");
  expect(answered.stdout).not.toContain("run created");
  expect(answered.stdout).toContain(`Run ${report.run.id}: completed`);
});

test("cancel stops a paused run", async () => {
  const { configPath } = fixture();
  const overrides = { jev: fakeJev(["ask-user"]), workers: { fake: new FakeWorker() } };
  const started = await cli(["run", "Add a feature file", "--config", configPath], overrides);
  expect(started.stdout).toContain("harness approvals answer");
  const cancelled = await cli(["cancel", runId(started.stdout), "--config", configPath], overrides);
  expect(cancelled.code).toBe(0);
  expect(cancelled.stdout).toContain(": cancelled");
  expect((await cli(["pause", runId(started.stdout), "--config", configPath], overrides)).code).toBe(1);
});

test("a missing Jev key is rejected unless the decision mode is deterministic", async () => {
  const { configPath } = fixture();
  const workers = { fake: new FakeWorker() };
  const missing = await cli(["run", "Add a feature file", "--config", configPath], { workers });
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("TYPESAFE_API_KEY");

  const bypass = await cli(
    ["run", "Add a feature file", "--config", configPath],
    { workers },
    {
      HARNESS_DECISION_MODE: "deterministic",
    },
  );
  expect(bypass.stdout).toContain("decision mode: deterministic");
  expect(bypass.stdout).toContain("decision bypassed: environment HARNESS_DECISION_MODE");

  const invalid = await cli(["run", "x", "--config", configPath], { workers }, { HARNESS_DECISION_MODE: "fast" });
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain("must be jev or deterministic");
});

test("agents list and providers doctor report configuration and preflight", async () => {
  const { configPath } = fixture();
  const agents = await cli(["agents", "list", "--config", configPath, "--json"]);
  expect(agents.code).toBe(0);
  expect(JSON.parse(agents.stdout)).toEqual([
    {
      name: "builder",
      provider: "fake",
      kind: "codex-cli",
      purpose: "implementation",
      readOnly: false,
      routing: ["defaultAgent", "complexAgent"],
    },
    {
      name: "reviewer",
      provider: "fake",
      kind: "codex-cli",
      purpose: "review",
      readOnly: true,
      routing: ["reviewerAgent"],
    },
  ]);

  const healthy = await cli(["providers", "doctor", "--config", configPath], {
    jev: fakeJev([]),
    workers: { fake: new FakeWorker() },
  });
  expect(healthy.code).toBe(0);
  expect(healthy.stdout).toContain("fake\tcodex-cli\tok\tfake 1.0");
  const unkeyed = await cli(["providers", "doctor", "--config", configPath, "--json"], {
    workers: { fake: new FakeWorker() },
  });
  expect(unkeyed.code).toBe(1);
  expect(JSON.parse(unkeyed.stdout)[0]).toMatchObject({ name: "jev", ok: false });
});

test("invalid arguments are usage errors", async () => {
  const { configPath } = fixture();
  expect((await cli(["run", "--config", configPath])).code).toBe(2);
  expect((await cli(["run", "x", "--decision-mode", "fast", "--config", configPath])).code).toBe(2);
  expect((await cli(["run", "x", "--dry-run"])).code).toBe(2);
  expect((await cli(["runs", "watch", "run-1", "--after", "-1"])).code).toBe(2);
  expect((await cli(["approvals", "list"])).code).toBe(2);
  expect((await cli(["pause"])).code).toBe(2);
});

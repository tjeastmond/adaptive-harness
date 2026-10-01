import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { HarnessRun } from "@adaptive-harness/core";
import { SqliteHarnessStore } from "@adaptive-harness/persistence";

const repository = resolve(import.meta.dir, "../../..");
const cli = resolve(repository, "apps/cli/src/cli.ts");
const example = await readFile(join(repository, "harness.example.yaml"), "utf8");
const dirs: string[] = [];

async function fixture(): Promise<{ dir: string; configPath: string; databasePath: string }> {
  const dir = await mkdtemp("/private/tmp/adaptive-harness-runs-cli-");
  dirs.push(dir);
  const configPath = join(dir, "harness.yaml");
  const databasePath = join(dir, ".harness", "harness.sqlite");
  await writeFile(configPath, example);
  return { dir, configPath, databasePath };
}

function spawn(dir: string, ...args: string[]) {
  return Bun.spawnSync(["bun", cli, ...args], {
    cwd: dir,
    env: { ...process.env, TYPESAFE_API_KEY: "" },
  });
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runs CLI", () => {
  test("lists and shows a synthetic run and its persisted events in a new process", async () => {
    const { dir, configPath, databasePath } = await fixture();
    await mkdir(join(dir, ".harness"));
    const store = new SqliteHarnessStore(databasePath);
    const run: HarnessRun = {
      id: "run-1",
      status: "created",
      objective: { text: "Check run history", acceptanceCriteria: ["Visible through CLI"] },
      workspace: dir,
      configPath,
      configHash: "fixture-hash",
      currentStep: 0,
      budget: {
        workerCalls: 2,
        inputTokens: 120,
        outputTokens: 30,
        elapsedMs: 0,
        estimatedWorkerCalls: 1,
      },
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T00:00:00.000Z",
    };
    await store.createRun(run);
    await store.appendEvent({
      id: "event-1",
      version: 1,
      sequence: 1,
      runId: run.id,
      occurredAt: run.createdAt,
      correlationId: "correlation-1",
      payload: { type: "run.created", run },
    });
    await store.appendEvent({
      id: "event-2",
      version: 1,
      sequence: 2,
      runId: run.id,
      occurredAt: run.createdAt,
      correlationId: "correlation-1",
      payload: { type: "run.paused", runId: run.id, reason: "fixture" },
    });
    store.close();

    const listed = spawn(dir, "runs", "list", "--json");
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout.toString())).toMatchObject([{ id: "run-1", status: "created" }]);

    const shown = spawn(dir, "runs", "show", "run-1", "--events", "--json");
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout.toString())).toMatchObject({
      run: { id: "run-1" },
      events: [
        { sequence: 1, payload: { type: "run.created" } },
        { sequence: 2, payload: { type: "run.paused" } },
      ],
    });

    const shownText = spawn(dir, "runs", "show", "run-1");
    expect(shownText.exitCode).toBe(0);
    expect(shownText.stdout.toString()).toContain(
      "Updated: 2026-09-23T00:00:00.000Z\nBudget: 2 worker calls, 120 input / 30 output tokens (1 call estimated)",
    );

    const firstPage = spawn(dir, "runs", "show", "run-1", "--events", "--limit", "1", "--json");
    expect(JSON.parse(firstPage.stdout.toString())).toMatchObject({
      events: [{ sequence: 1 }],
      nextAfter: 1,
    });
    const secondPage = spawn(dir, "runs", "show", "run-1", "--events", "--after", "1", "--json");
    expect(JSON.parse(secondPage.stdout.toString())).toMatchObject({ events: [{ sequence: 2 }] });
  });

  test("prints a removed-limit config warning once on stderr", async () => {
    const { dir, configPath, databasePath } = await fixture();
    await mkdir(join(dir, ".harness"));
    new SqliteHarnessStore(databasePath).close();
    await writeFile(configPath, example.replace("  maxInputTokens:", "  maxCostUsd: 10\n  maxInputTokens:"));
    const result = spawn(dir, "runs", "list");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("No runs found.");
    const warning = "Warning: limits.maxCostUsd was removed and is ignored";
    expect(result.stderr.toString().split(warning)).toHaveLength(2);
  });

  test("does not create a database when none exists", async () => {
    const { dir, databasePath } = await fixture();
    const result = spawn(dir, "runs", "list");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Run database not found");
    expect(await Bun.file(databasePath).exists()).toBe(false);
  });

  test("does not migrate an existing uninitialized database while reading", async () => {
    const { dir, databasePath } = await fixture();
    await mkdir(join(dir, ".harness"));
    const db = new Database(databasePath, { create: true });
    db.close();

    const result = spawn(dir, "runs", "list");
    expect(result.exitCode).toBe(1);
    const reopened = new Database(databasePath);
    expect((reopened.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
    reopened.close();
  });
});

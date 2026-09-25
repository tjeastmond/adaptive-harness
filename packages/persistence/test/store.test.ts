import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HarnessRun, HarnessTask } from "@adaptive-harness/core";
import type { EventEnvelope } from "@adaptive-harness/protocol";
import { type DecisionRecord, SqliteHarnessStore, type WorkerCallRecord } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-persistence-"));
  dirs.push(dir);
  return join(dir, "run.sqlite");
}
const now = "2026-09-23T12:00:00.000Z";
function run(id = "run-1", status: HarnessRun["status"] = "created"): HarnessRun {
  return {
    id,
    status,
    objective: { text: "Test", acceptanceCriteria: ["works"] },
    workspace: "/tmp/work",
    configPath: "/tmp/harness.yaml",
    configHash: "hash",
    currentStep: 0,
    budget: { workerCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, elapsedMs: 0 },
    createdAt: now,
    updatedAt: now,
  };
}
function event(sequence: number, runId = "run-1"): EventEnvelope {
  return {
    id: `${runId}-event-${sequence}`,
    version: 1,
    sequence,
    runId,
    occurredAt: now,
    correlationId: "correlation",
    payload: { type: "run.paused", runId, reason: `reason ${sequence}` },
  };
}

test("migration is idempotent and enables WAL and foreign keys", async () => {
  const path = databasePath();
  const first = new SqliteHarnessStore(path);
  await first.createRun(run());
  first.close();
  const second = new SqliteHarnessStore(path);
  expect(await second.getRun("run-1")).toEqual(run());
  second.close();
  const db = new Database(path);
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
  expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  db.close();
});

test("creates a missing parent directory for the configured database", async () => {
  const path = join(dirname(databasePath()), ".harness", "harness.sqlite");
  const store = new SqliteHarnessStore(path);
  await store.createRun(run());
  expect(await store.getRun("run-1")).toEqual(run());
  store.close();
});

test("read-only open rejects an unmigrated database without changing it", () => {
  const path = databasePath();
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY)");
  db.close();
  expect(() => new SqliteHarnessStore(path, { readonly: true })).toThrow("Unsupported database schema version 0");
  const unchanged = new Database(path, { readonly: true });
  expect((unchanged.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
  expect(unchanged.query("SELECT name FROM sqlite_master WHERE name = 'sentinel'").get()).toBeTruthy();
  expect(unchanged.query("SELECT name FROM sqlite_master WHERE name = 'runs'").get()).toBeNull();
  unchanged.close();
});

test("read-only open reads migrated data and cannot write", async () => {
  const path = databasePath();
  const writable = new SqliteHarnessStore(path);
  await writable.createRun(run());
  writable.close();
  const readonly = new SqliteHarnessStore(path, { readonly: true });
  expect(await readonly.getRun("run-1")).toEqual(run());
  await expect(readonly.createRun(run("other"))).rejects.toThrow();
  readonly.close();
});

test("creates, updates, filters, and limits runs", async () => {
  const store = new SqliteHarnessStore(databasePath());
  await store.createRun(run("one"));
  await store.createRun(run("two", "running"));
  expect(await store.getRun("missing")).toBeUndefined();
  expect((await store.listRuns({ status: "running" })).map((r) => r.id)).toEqual(["two"]);
  expect(await store.listRuns({ limit: 1 })).toHaveLength(1);
  const updated = { ...run("one"), status: "completed" as const, updatedAt: "2026-09-23T12:01:00.000Z" };
  await store.updateRun(updated);
  expect(await store.getRun("one")).toEqual(updated);
  expect((await store.listRuns())[0]?.id).toBe("one");
  await expect(store.updateRun(run("missing"))).rejects.toThrow("does not exist");
  await expect(store.listRuns({ limit: 0 })).rejects.toThrow("Run limit");
  store.close();
});

test("task, decision, and worker call records round trip", async () => {
  const store = new SqliteHarnessStore(databasePath());
  await store.createRun(run());
  const task: HarnessTask = {
    id: "task-1",
    runId: "run-1",
    kind: "implementation",
    objective: { text: "Do work", acceptanceCriteria: [] },
    attempt: 1,
    access: { mode: "write" },
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
  await store.saveTask(task);
  await store.createRun(run("other"));
  await expect(store.saveTask({ ...task, runId: "other" })).rejects.toThrow("cannot change run");
  expect(await store.getTask(task.id)).toEqual(task);
  expect(await store.listTasks("run-1")).toEqual([task]);
  const decision: DecisionRecord = {
    id: "decision-1",
    runId: "run-1",
    phase: "route",
    createdAt: now,
    requestStateHash: "statehash",
    response: { id: "decision-1", model: "jev", answers: {}, usage: {}, durationMs: 12, raw: {} },
  };
  await store.saveDecision(decision);
  await expect(store.saveDecision({ ...decision, runId: "other" })).rejects.toThrow("cannot change run");
  expect(await store.getDecision(decision.id)).toEqual(decision);
  expect(await store.listDecisions("run-1")).toEqual([decision]);
  const call: WorkerCallRecord = {
    id: "call-1",
    runId: "run-1",
    taskId: task.id,
    createdAt: now,
    model: "codex",
    result: {
      id: "call-1",
      provider: "codex",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      durationMs: 1,
      exitCode: 0,
      finalOutput: "ok",
      usage: {},
      rawEventCount: 0,
    },
  };
  await store.saveWorkerCall(call);
  await expect(store.saveWorkerCall({ ...call, runId: "other" })).rejects.toThrow("cannot change run");
  await expect(store.saveWorkerCall({ ...call, taskId: "other-task" })).rejects.toThrow("cannot change run");
  await expect(store.saveWorkerCall({ ...call, id: "cross-run-call", runId: "other" })).rejects.toThrow();
  expect(await store.getWorkerCall(call.id)).toEqual(call);
  expect(await store.listWorkerCalls("run-1")).toEqual([call]);
  store.close();
});

test("events are append-only, ordered per run, and replay after reopen", async () => {
  const path = databasePath();
  const store = new SqliteHarnessStore(path);
  await store.createRun(run());
  await store.createRun(run("other"));
  await store.appendEvent(event(1));
  await store.appendEvent(event(1, "other"));
  await expect(store.appendEvent(event(3))).rejects.toThrow("must be 2");
  await expect(store.appendEvent(event(1))).rejects.toThrow("must be 2");
  await expect(store.appendEvent({ ...event(2), version: 2 as 1 })).rejects.toThrow("Unsupported event version");
  await expect(store.appendEvent({ ...event(2), runId: "other" })).rejects.toThrow("payload run ID");
  await store.appendEvent(event(2));
  store.close();
  const reopened = new SqliteHarnessStore(path);
  expect((await reopened.listEvents("run-1")).map((e) => e.sequence)).toEqual([1, 2]);
  expect((await reopened.listEvents("run-1", 1)).map((e) => e.sequence)).toEqual([2]);
  expect((await reopened.listEvents("other")).map((e) => e.sequence)).toEqual([1]);
  reopened.close();
});

test("event lists page in sequence order with a bounded limit", async () => {
  const store = new SqliteHarnessStore(databasePath());
  await store.createRun(run());
  for (let sequence = 1; sequence <= 4; sequence++) await store.appendEvent(event(sequence));
  expect((await store.listEvents("run-1", 0, 2)).map((item) => item.sequence)).toEqual([1, 2]);
  expect((await store.listEvents("run-1", 2, 2)).map((item) => item.sequence)).toEqual([3, 4]);
  await expect(store.listEvents("run-1", 0, 0)).rejects.toThrow("Event limit");
  await expect(store.listEvents("run-1", 0, 1001)).rejects.toThrow("Event limit");
  store.close();
});

test("stored event JSON redacts credential keys and secret values and enforces a payload cap", async () => {
  const store = new SqliteHarnessStore(databasePath(), { maxJsonBytes: 500, redactValues: ["", "private"] });
  await store.createRun(run());
  await store.appendEvent({
    ...event(1),
    payload: {
      type: "run.paused",
      runId: "run-1",
      reason: "paused with private key",
      apiKey: "private",
      "private metadata": "ordinary value",
    } as EventEnvelope["payload"],
  });
  expect(JSON.stringify(await store.listEvents("run-1"))).not.toContain("private");
  expect(JSON.stringify(await store.listEvents("run-1"))).toContain("[REDACTED]");
  await expect(
    store.appendEvent({
      ...event(2),
      payload: {
        type: "run.paused",
        runId: "run-1",
        reason: "x".repeat(1_000),
      },
    }),
  ).rejects.toThrow("size limit");
  expect(await store.listEvents("run-1")).toHaveLength(1);
  store.close();
});

test("run commits are fenced by the lease owner and apply atomically", async () => {
  const store = new SqliteHarnessStore(databasePath());
  await store.createRun(run());
  const later = "2026-09-23T12:01:00.000Z";
  expect(await store.acquireRunLease("run-1", "a", now, now)).toBe(true);
  expect(await store.acquireRunLease("run-1", "b", now, now)).toBe(false);
  await expect(store.commitRun("run-1", "b", { checkpoint: { phase: "work" } })).rejects.toThrow("lease is not held");
  await store.requestRunControl("run-1", "pause");
  await store.commitRun("run-1", "a", {
    run: { ...run(), status: "paused", updatedAt: later },
    checkpoint: { phase: "work" },
    events: [event(1)],
    clearControls: ["pause"],
  });
  expect(await store.getRunControl("run-1")).toMatchObject({
    owner: "a",
    pauseRequested: false,
    checkpoint: { phase: "work" },
  });
  await expect(store.commitRun("run-1", "a", { checkpoint: { phase: "verify" }, events: [event(3)] })).rejects.toThrow(
    "must be 2",
  );
  expect((await store.getRunControl("run-1"))?.checkpoint).toEqual({ phase: "work" });
  expect(await store.acquireRunLease("run-1", "b", later, later)).toBe(true);
  store.close();
});

test("approval updates keep their run and creation time or fail loudly", async () => {
  const store = new SqliteHarnessStore(databasePath());
  await store.createRun(run());
  await store.acquireRunLease("run-1", "owner", now, now);
  const approval = {
    id: "approval-1",
    runId: "run-1",
    kind: "clarification" as const,
    prompt: "Which file?",
    status: "pending" as const,
    createdAt: now,
  };
  await store.commitRun("run-1", "owner", { approval });
  await expect(
    store.commitRun("run-1", "owner", {
      approval: { ...approval, status: "answered", createdAt: "2026-09-23T12:05:00.000Z" },
    }),
  ).rejects.toThrow("different request");
  expect((await store.getApproval("approval-1"))?.status).toBe("pending");
  await store.commitRun("run-1", "owner", { approval: { ...approval, status: "answered", answer: "a.ts" } });
  expect(await store.listApprovals("run-1", "answered")).toEqual([{ ...approval, status: "answered", answer: "a.ts" }]);
  expect(await store.listApprovals("run-1", "pending")).toEqual([]);
  store.close();
});

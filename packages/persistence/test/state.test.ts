import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextAssembly, ContextAssemblyRequest, HarnessRun, StateChunk } from "@adaptive-harness/core";
import type { EventEnvelope } from "@adaptive-harness/protocol";
import { RecordingContextAssembler, SqliteHarnessStore } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function path(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-state-"));
  dirs.push(dir);
  return join(dir, "harness.sqlite");
}
const now = "2026-09-23T12:00:00.000Z";
function run(id = "run-1"): HarnessRun {
  return {
    id,
    status: "created",
    objective: { text: "Ship feature", acceptanceCriteria: ["checks pass"] },
    workspace: "/tmp/work",
    configPath: "/tmp/config.yaml",
    configHash: "hash",
    currentStep: 0,
    budget: { workerCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, elapsedMs: 0 },
    createdAt: now,
    updatedAt: now,
  };
}
function chunk(id: string, runId = "run-1", type: StateChunk["type"] = "observation"): StateChunk {
  return { id, runId, type, source: "test", createdAt: now, metadata: {}, content: `content ${id}` };
}
function event(sequence: number): EventEnvelope {
  return {
    id: `event-${sequence}`,
    version: 1,
    sequence,
    runId: "run-1",
    occurredAt: now,
    correlationId: "correlation",
    payload: { type: "run.paused", runId: "run-1", reason: `step ${sequence}` },
  };
}

test("migrates an existing version 1 database without replacing its run", async () => {
  const databasePath = path();
  const db = new Database(databasePath, { create: true });
  db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
      sequence INTEGER NOT NULL CHECK(sequence > 0), version INTEGER NOT NULL CHECK(version = 1),
      occurred_at TEXT NOT NULL, correlation_id TEXT NOT NULL, causation_id TEXT,
      payload TEXT NOT NULL, UNIQUE(run_id, sequence)
    );
    PRAGMA user_version = 1;`);
  const existing = run();
  db.query("INSERT INTO runs VALUES (?, ?, ?, ?, ?)").run(
    existing.id,
    existing.status,
    existing.createdAt,
    existing.updatedAt,
    JSON.stringify(existing),
  );
  const existingEvent = event(1);
  db.query("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    existingEvent.id,
    existingEvent.runId,
    existingEvent.sequence,
    existingEvent.version,
    existingEvent.occurredAt,
    existingEvent.correlationId,
    null,
    JSON.stringify(existingEvent.payload),
  );
  db.close();
  const reader = new SqliteHarnessStore(databasePath, { readonly: true });
  expect(await reader.getRun(existing.id)).toEqual(existing);
  expect(await reader.listRuns()).toEqual([existing]);
  expect(await reader.listEvents(existing.id)).toEqual([existingEvent]);
  await expect(reader.list(existing.id)).rejects.toThrow("require database schema version 2");
  await expect(reader.getContextAssembly("old")).rejects.toThrow("require database schema version 2");
  reader.close();
  const beforeMigration = new Database(databasePath, { readonly: true });
  expect((beforeMigration.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
  beforeMigration.close();
  const store = new SqliteHarnessStore(databasePath);
  expect(await store.getRun(existing.id)).toEqual(existing);
  await store.append(chunk("new-state"));
  expect(await store.get("new-state")).toEqual(chunk("new-state"));
  store.close();
  const migrated = new Database(databasePath, { readonly: true });
  expect((migrated.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
  migrated.close();
});

test("state chunks are durable, ordered by append, run scoped and bounded", async () => {
  const databasePath = path();
  const store = new SqliteHarnessStore(databasePath, { redactValues: ["private"] });
  await store.createRun(run());
  await store.createRun(run("other"));
  await store.append({ ...chunk("one"), content: { ordinaryText: "private evidence" } });
  await store.append(chunk("other-run", "other"));
  await store.append(chunk("two", "run-1", "review"));
  await store.append(chunk("three"));
  expect((await store.list("run-1")).map((item) => item.id)).toEqual(["one", "two", "three"]);
  expect((await store.list("run-1", { limit: 2 })).map((item) => item.id)).toEqual(["two", "three"]);
  expect((await store.list("run-1", { types: ["observation"], limit: 1 })).map((item) => item.id)).toEqual(["three"]);
  expect(await store.list("run-1", { types: [] })).toEqual([]);
  expect(await store.list("run-1", { limit: 0 })).toEqual([]);
  await expect(store.list("run-1", { limit: 1001 })).rejects.toThrow("State chunk limit");
  await expect(store.append(chunk("one"))).rejects.toThrow();
  store.close();
  const reopened = new SqliteHarnessStore(databasePath, { readonly: true });
  expect((await reopened.list("run-1")).map((item) => item.id)).toEqual(["one", "two", "three"]);
  expect(JSON.stringify(await reopened.get("one"))).not.toContain("private");
  expect((await reopened.list("other")).map((item) => item.id)).toEqual(["other-run"]);
  reopened.close();
});

test("recorded context preserves selected order, visibility, purpose and exact hash across restart", async () => {
  const databasePath = path();
  const store = new SqliteHarnessStore(databasePath);
  await store.createRun(run());
  await store.append(chunk("old"));
  await store.append(chunk("new"));
  const request: ContextAssemblyRequest = { runId: "run-1", purpose: "worker", objective: run().objective };
  const assembler = new RecordingContextAssembler(store);
  const assembly = await assembler.assemble(request);
  expect(assembly.chunks.map(({ chunk: selected }) => selected.id)).toEqual(["old", "new"]);
  const recorded = await store.listContextAssemblies("run-1");
  expect(recorded).toHaveLength(1);
  const firstRecord = recorded[0];
  if (!firstRecord) throw new Error("Expected recorded context assembly");
  expect(firstRecord.selectedChunks).toEqual(
    assembly.chunks.map(({ chunk: selected, visibility }) => ({
      chunkId: selected.id,
      visibility,
    })),
  );
  expect(firstRecord.purpose).toBe("worker");
  expect(firstRecord.summary).toBe(assembly.summary);
  expect(firstRecord.renderedContentHash).toBe(createHash("sha256").update(assembly.summary).digest("hex"));
  await store.appendEvent(event(1));
  store.close();
  const reopened = new SqliteHarnessStore(databasePath, { readonly: true });
  expect(await reopened.getContextAssembly(firstRecord.id)).toEqual(firstRecord);
  expect(createHash("sha256").update(firstRecord.summary).digest("hex")).toBe(firstRecord.renderedContentHash);
  expect(await reopened.listContextAssemblies("run-1")).toEqual(recorded);
  expect((await reopened.listEvents("run-1")).map((item) => item.sequence)).toEqual([1]);
  reopened.close();
  const writer = new SqliteHarnessStore(databasePath);
  await writer.appendEvent(event(2));
  expect((await writer.listEvents("run-1")).map((item) => item.sequence)).toEqual([1, 2]);
  expect(await writer.listContextAssemblies("run-1")).toEqual(recorded);
  writer.close();
});

test("an older explicit candidate survives the default 500-chunk bound and replays exact truncated context", async () => {
  const databasePath = path();
  const store = new SqliteHarnessStore(databasePath);
  await store.createRun(run());
  await store.append({ ...chunk("early"), content: "A".repeat(2_000) });
  for (let index = 0; index < 520; index++) await store.append(chunk(`later-${index}`));
  expect((await store.list("run-1")).some((item) => item.id === "early")).toBe(false);
  expect((await store.list("run-1", { ids: ["early"] })).map((item) => item.id)).toEqual(["early"]);
  await expect(
    store.list("run-1", { ids: Array.from({ length: 1_001 }, (_, index) => `id-${index}`) }),
  ).rejects.toThrow("ID filter");
  const request: ContextAssemblyRequest = {
    runId: "run-1",
    purpose: "verification",
    objective: { text: "Check the task-specific implementation", acceptanceCriteria: ["passes its own check"] },
    candidateChunkIds: ["early"],
  };
  const assembly = await new RecordingContextAssembler(store, { maxCharacters: 150 }).assemble(request);
  expect(assembly.chunks.map(({ chunk: selected }) => selected.id)).toEqual(["early"]);
  expect(assembly.chunks[0]?.visibility).toBe("short");
  store.close();
  const reopened = new SqliteHarnessStore(databasePath, { readonly: true });
  const evidence = (await reopened.listContextAssemblies("run-1"))[0];
  if (!evidence) throw new Error("Expected context evidence");
  expect(evidence.summary).toBe(assembly.summary);
  expect(evidence.summary).toContain("Check the task-specific implementation");
  expect(evidence.selectedChunks).toEqual([{ chunkId: "early", visibility: "short" }]);
  expect(createHash("sha256").update(evidence.summary).digest("hex")).toBe(evidence.renderedContentHash);
  reopened.close();
});

test("recording rejects a context summary containing a configured secret", async () => {
  const store = new SqliteHarnessStore(path(), { redactValues: ["private"] });
  await store.createRun(run());
  const request: ContextAssemblyRequest = {
    runId: "run-1",
    purpose: "decision",
    objective: { text: "Use private credential", acceptanceCriteria: [] },
  };
  await expect(new RecordingContextAssembler(store).assemble(request)).rejects.toThrow("redacted or truncated");
  expect(await store.listContextAssemblies("run-1")).toEqual([]);
  store.close();
});

test("context evidence rejects a false hash and chunks from another run", async () => {
  const store = new SqliteHarnessStore(path());
  await store.createRun(run());
  await store.createRun(run("other"));
  await store.append(chunk("foreign", "other"));
  const request: ContextAssemblyRequest = { runId: "run-1", purpose: "decision", objective: run().objective };
  const summary = "exact rendered content";
  const assembly: ContextAssembly = {
    summary,
    renderedContentHash: createHash("sha256").update(summary).digest("hex"),
    chunks: [{ chunk: chunk("foreign", "other"), visibility: "short" }],
  };
  await expect(store.recordContextAssembly(request, { ...assembly, renderedContentHash: "false" })).rejects.toThrow(
    "hash does not match",
  );
  await expect(store.recordContextAssembly(request, assembly, { id: "assembly-1", createdAt: now })).rejects.toThrow(
    "does not belong",
  );
  expect(await store.listContextAssemblies("run-1")).toEqual([]);
  store.close();
});

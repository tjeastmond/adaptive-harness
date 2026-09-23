import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DecisionResponse, HarnessRun, HarnessTask, RunStatus, WorkerResult } from "@adaptive-harness/core";
import type { EventEnvelope } from "@adaptive-harness/protocol";

export interface DecisionRecord {
  id: string;
  runId: string;
  createdAt: string;
  phase: "route" | "completion" | "handoff" | "context";
  requestStateHash: string;
  response: DecisionResponse;
}

export interface WorkerCallRecord {
  id: string;
  runId: string;
  taskId: string;
  createdAt: string;
  model?: string;
  result: WorkerResult;
}

export interface StoreOptions {
  /** Applied to all stored JSON, before default key redaction and size validation. */
  redact?: (value: unknown) => unknown;
  /** Literal secrets to replace wherever they appear in stored strings, including JSON keys. */
  redactValues?: string[];
  maxJsonBytes?: number;
  /** Open an existing, migrated database without any write or filesystem mutation. */
  readonly?: boolean;
}

const SECRET_KEY =
  /^(?:.*(?:secret|password|credential|api[_-]?key|authorization)|(?:access|refresh|auth|bearer)[_-]?token|token)$/i;
const MAX_STRING_LENGTH = 64_000;
const MAX_ITEMS = 1_000;
const DEFAULT_MAX_JSON_BYTES = 1_000_000;

function sanitize(value: unknown, redactValues: string[], seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    let redacted = value;
    for (const secret of redactValues) {
      if (secret) redacted = redacted.split(secret).join("[REDACTED]");
    }
    return redacted.slice(0, MAX_STRING_LENGTH);
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new Error("Cannot persist circular JSON");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => sanitize(item, redactValues, seen));
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_ITEMS)
        .map(([key, item]) => [
          sanitize(key, redactValues),
          SECRET_KEY.test(key) ? "[REDACTED]" : sanitize(item, redactValues, seen),
        ]),
    );
  } finally {
    seen.delete(value);
  }
}

function json(value: unknown, options: StoreOptions): string {
  const serialized = JSON.stringify(
    sanitize(options.redact ? options.redact(value) : value, options.redactValues ?? []),
  );
  if (serialized === undefined) throw new Error("Cannot persist undefined JSON");
  if (Buffer.byteLength(serialized, "utf8") > (options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES)) {
    throw new Error("Persisted JSON exceeds configured size limit");
  }
  return serialized;
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}
interface JsonRow {
  data: string;
}
interface EventRow {
  id: string;
  version: number;
  sequence: number;
  run_id: string;
  occurred_at: string;
  correlation_id: string;
  causation_id: string | null;
  payload: string;
}

const MIGRATIONS = [
  `CREATE TABLE runs (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX runs_updated_at ON runs(updated_at DESC, id);
  CREATE INDEX runs_status_updated_at ON runs(status, updated_at DESC, id);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
    created_at TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(id, run_id)
  );
  CREATE INDEX tasks_run_created ON tasks(run_id, created_at, id);
  CREATE TABLE events (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
    sequence INTEGER NOT NULL CHECK(sequence > 0), version INTEGER NOT NULL CHECK(version = 1),
    occurred_at TEXT NOT NULL, correlation_id TEXT NOT NULL, causation_id TEXT,
    payload TEXT NOT NULL, UNIQUE(run_id, sequence)
  );
  CREATE INDEX events_run_sequence ON events(run_id, sequence);
  CREATE TABLE decisions (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
    created_at TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX decisions_run_created ON decisions(run_id, created_at, id);
  CREATE TABLE worker_calls (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
    task_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL,
    FOREIGN KEY(task_id, run_id) REFERENCES tasks(id, run_id)
  );
  CREATE INDEX worker_calls_run_created ON worker_calls(run_id, created_at, id);`,
] as const;

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Run limit must be an integer from 1 to 1000");
  }
  return limit;
}

function boundedEventLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Event limit must be an integer from 1 to 1000");
  }
  return limit;
}

export class SqliteHarnessStore {
  readonly #db: Database;
  readonly #options: StoreOptions;

  constructor(databasePath: string, options: StoreOptions = {}) {
    this.#options = options;
    if (!options.readonly && databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.#db = new Database(databasePath, options.readonly ? { readonly: true } : { create: true });
    if (!options.readonly) this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const version = this.#db.query("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > MIGRATIONS.length || (options.readonly && version.user_version !== MIGRATIONS.length)) {
      this.#db.close();
      throw new Error(`Unsupported database schema version ${version.user_version}`);
    }
    for (let index = version.user_version; index < MIGRATIONS.length; index++) {
      const migration = MIGRATIONS[index];
      if (!migration) throw new Error(`Missing database migration ${index + 1}`);
      this.#db.transaction(() => {
        this.#db.exec(migration);
        this.#db.exec(`PRAGMA user_version = ${index + 1}`);
      })();
    }
  }

  close(): void {
    this.#db.close();
  }

  async createRun(run: HarnessRun): Promise<void> {
    this.#db
      .query("INSERT INTO runs(id, status, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?)")
      .run(run.id, run.status, run.createdAt, run.updatedAt, json(run, this.#options));
  }

  async updateRun(run: HarnessRun): Promise<void> {
    const result = this.#db
      .query("UPDATE runs SET status = ?, updated_at = ?, data = ? WHERE id = ?")
      .run(run.status, run.updatedAt, json(run, this.#options), run.id);
    if (result.changes === 0) throw new Error(`Run ${run.id} does not exist`);
  }

  async getRun(runId: string): Promise<HarnessRun | undefined> {
    const row = this.#db.query("SELECT data FROM runs WHERE id = ?").get(runId) as JsonRow | null;
    return row ? parse<HarnessRun>(row.data) : undefined;
  }

  async listRuns(options: { limit?: number; status?: RunStatus } = {}): Promise<HarnessRun[]> {
    const limit = boundedLimit(options.limit);
    const rows = options.status
      ? this.#db
          .query("SELECT data FROM runs WHERE status = ? ORDER BY updated_at DESC, id LIMIT ?")
          .all(options.status, limit)
      : this.#db.query("SELECT data FROM runs ORDER BY updated_at DESC, id LIMIT ?").all(limit);
    return (rows as JsonRow[]).map((row) => parse<HarnessRun>(row.data));
  }

  async appendEvent(event: EventEnvelope): Promise<void> {
    if (event.version !== 1) throw new Error(`Unsupported event version ${event.version}`);
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error("Invalid event sequence");
    const eventPayload = event.payload as unknown as {
      runId?: string;
      run?: { id: string };
      request?: { runId: string };
    };
    const payloadRunId = eventPayload.runId ?? eventPayload.run?.id ?? eventPayload.request?.runId;
    if (payloadRunId !== event.runId) throw new Error("Event payload run ID does not match envelope run ID");
    const payload = json(event.payload, this.#options);
    this.#db.transaction(() => {
      const row = this.#db
        .query("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE run_id = ?")
        .get(event.runId) as { sequence: number };
      if (event.sequence !== row.sequence + 1) {
        throw new Error(`Event sequence for run ${event.runId} must be ${row.sequence + 1}`);
      }
      this.#db
        .query(
          `INSERT INTO events
        (id, run_id, sequence, version, occurred_at, correlation_id, causation_id, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.runId,
          event.sequence,
          event.version,
          event.occurredAt,
          event.correlationId,
          event.causationId ?? null,
          payload,
        );
    })();
  }

  async listEvents(runId: string, afterSequence = 0, limit = 500): Promise<EventEnvelope[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("Invalid event cursor");
    boundedEventLimit(limit);
    const rows = this.#db
      .query(
        `SELECT id, run_id, sequence, version, occurred_at,
      correlation_id, causation_id, payload FROM events
      WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
      )
      .all(runId, afterSequence, limit) as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      sequence: row.sequence,
      version: row.version as 1,
      occurredAt: row.occurred_at,
      correlationId: row.correlation_id,
      ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
      payload: parse<EventEnvelope["payload"]>(row.payload),
    }));
  }

  async saveTask(task: HarnessTask): Promise<void> {
    const result = this.#db
      .query(
        `INSERT INTO tasks(id, run_id, created_at, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data
      WHERE tasks.run_id = excluded.run_id AND tasks.created_at = excluded.created_at`,
      )
      .run(task.id, task.runId, task.createdAt, json(task, this.#options));
    if (result.changes === 0) throw new Error(`Task ${task.id} cannot change run or creation time`);
  }
  async getTask(id: string): Promise<HarnessTask | undefined> {
    return this.#get<HarnessTask>("tasks", id);
  }
  async listTasks(runId: string): Promise<HarnessTask[]> {
    return this.#list<HarnessTask>("tasks", runId);
  }

  async saveDecision(record: DecisionRecord): Promise<void> {
    const result = this.#db
      .query(
        `INSERT INTO decisions(id, run_id, created_at, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data
      WHERE decisions.run_id = excluded.run_id AND decisions.created_at = excluded.created_at`,
      )
      .run(record.id, record.runId, record.createdAt, json(record, this.#options));
    if (result.changes === 0) throw new Error(`Decision ${record.id} cannot change run or creation time`);
  }
  async getDecision(id: string): Promise<DecisionRecord | undefined> {
    return this.#get<DecisionRecord>("decisions", id);
  }
  async listDecisions(runId: string): Promise<DecisionRecord[]> {
    return this.#list<DecisionRecord>("decisions", runId);
  }

  async saveWorkerCall(record: WorkerCallRecord): Promise<void> {
    const result = this.#db
      .query(
        `INSERT INTO worker_calls(id, run_id, task_id, created_at, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data
      WHERE worker_calls.run_id = excluded.run_id
      AND worker_calls.task_id = excluded.task_id
      AND worker_calls.created_at = excluded.created_at`,
      )
      .run(record.id, record.runId, record.taskId, record.createdAt, json(record, this.#options));
    if (result.changes === 0) throw new Error(`Worker call ${record.id} cannot change run, task, or creation time`);
  }
  async getWorkerCall(id: string): Promise<WorkerCallRecord | undefined> {
    return this.#get<WorkerCallRecord>("worker_calls", id);
  }
  async listWorkerCalls(runId: string): Promise<WorkerCallRecord[]> {
    return this.#list<WorkerCallRecord>("worker_calls", runId);
  }

  #get<T>(table: "tasks" | "decisions" | "worker_calls", id: string): T | undefined {
    const row = this.#db.query(`SELECT data FROM ${table} WHERE id = ?`).get(id) as JsonRow | null;
    return row ? parse<T>(row.data) : undefined;
  }
  #list<T>(table: "tasks" | "decisions" | "worker_calls", runId: string): T[] {
    const rows = this.#db
      .query(`SELECT data FROM ${table} WHERE run_id = ? ORDER BY created_at, id`)
      .all(runId) as JsonRow[];
    return rows.map((row) => parse<T>(row.data));
  }
}

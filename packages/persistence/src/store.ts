import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ContextAssembly,
  ContextAssemblyRequest,
  ContextVisibility,
  DecisionMode,
  DecisionPhase,
  DecisionQuestion,
  DecisionResponse,
  HarnessRun,
  HarnessTask,
  RunStatus,
  StateChunk,
  StateChunkType,
  StateStore,
  WorkerResult,
} from "@adaptive-harness/core";
import type { ApprovalRequest, EventEnvelope } from "@adaptive-harness/protocol";

export interface DecisionRecord {
  id: string;
  runId: string;
  createdAt: string;
  phase: DecisionPhase;
  requestStateHash: string;
  questions?: Record<string, DecisionQuestion>;
  response?: DecisionResponse;
  requestedMode?: DecisionMode;
  selectedMode?: DecisionMode;
  fallbackReason?: string;
  previousResponse?: DecisionResponse;
  errorCode?: string;
}

export interface WorkerCallRecord {
  id: string;
  runId: string;
  taskId: string;
  createdAt: string;
  model?: string;
  result: WorkerResult;
}

export interface ContextAssemblyRecord {
  id: string;
  runId: string;
  purpose: ContextAssemblyRequest["purpose"];
  createdAt: string;
  selectedChunks: Array<{ chunkId: string; visibility: ContextVisibility }>;
  summary: string;
  renderedContentHash: string;
}

/** Cross-process run ownership and control requests. The checkpoint shape belongs to the runtime. */
export interface RunControl {
  runId: string;
  owner?: string;
  heartbeatAt?: string;
  pauseRequested: boolean;
  cancelRequested: boolean;
  checkpoint?: unknown;
}

/** Changes committed atomically by the current lease owner. */
export interface RunCommit {
  run?: HarnessRun;
  checkpoint?: unknown;
  events?: EventEnvelope[];
  approval?: ApprovalRequest;
  clearControls?: Array<"pause" | "cancel">;
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
interface ControlRow {
  run_id: string;
  owner: string | null;
  heartbeat_at: string | null;
  pause_requested: number;
  cancel_requested: number;
  checkpoint: string | null;
}
interface ContextRow {
  id: string;
  run_id: string;
  purpose: ContextAssemblyRequest["purpose"];
  created_at: string;
  selected_chunks: string;
  rendered_summary: string;
  rendered_content_hash: string;
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
  `CREATE TABLE state_chunks (
    ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL REFERENCES runs(id),
    type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX state_chunks_run_ordinal ON state_chunks(run_id, ordinal);
  CREATE INDEX state_chunks_run_type_ordinal ON state_chunks(run_id, type, ordinal);
  CREATE TABLE context_assemblies (
    ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL REFERENCES runs(id),
    purpose TEXT NOT NULL,
    created_at TEXT NOT NULL,
    selected_chunks TEXT NOT NULL,
    rendered_summary TEXT NOT NULL,
    rendered_content_hash TEXT NOT NULL
  );
  CREATE INDEX context_assemblies_run_ordinal ON context_assemblies(run_id, ordinal);`,
  `CREATE TABLE run_controls (
    run_id TEXT PRIMARY KEY REFERENCES runs(id),
    owner TEXT,
    heartbeat_at TEXT,
    pause_requested INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    checkpoint TEXT
  );
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
    status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX approvals_run_created ON approvals(run_id, created_at, id);`,
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

export class SqliteHarnessStore implements StateStore {
  readonly #db: Database;
  readonly #options: StoreOptions;
  readonly #schemaVersion: number;

  constructor(databasePath: string, options: StoreOptions = {}) {
    this.#options = options;
    if (!options.readonly && databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.#db = new Database(databasePath, options.readonly ? { readonly: true } : { create: true });
    if (!options.readonly) this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const version = this.#db.query("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > MIGRATIONS.length || (options.readonly && version.user_version < 1)) {
      this.#db.close();
      throw new Error(`Unsupported database schema version ${version.user_version}`);
    }
    this.#schemaVersion = options.readonly ? version.user_version : MIGRATIONS.length;
    for (let index = options.readonly ? MIGRATIONS.length : version.user_version; index < MIGRATIONS.length; index++) {
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
    this.#updateRun(run);
  }

  #updateRun(run: HarnessRun): void {
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
    this.#appendEvent(event);
  }

  /** The highest event sequence for a run, or 0 when it has none. */
  async lastEventSequence(runId: string): Promise<number> {
    const row = this.#db
      .query("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE run_id = ?")
      .get(runId) as { sequence: number };
    return row.sequence;
  }

  #appendEvent(event: EventEnvelope): void {
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

  /** Claims a run when it is unowned, already ours, or its owner stopped renewing before staleBefore. */
  async acquireRunLease(runId: string, owner: string, now: string, staleBefore: string): Promise<boolean> {
    return this.#db.transaction(() => {
      this.#db.query("INSERT OR IGNORE INTO run_controls(run_id) VALUES (?)").run(runId);
      const result = this.#db
        .query(
          `UPDATE run_controls SET owner = ?, heartbeat_at = ?
        WHERE run_id = ? AND (owner IS NULL OR owner = ? OR heartbeat_at IS NULL OR heartbeat_at < ?)`,
        )
        .run(owner, now, runId, owner, staleBefore);
      return result.changes > 0;
    })();
  }

  async renewRunLease(runId: string, owner: string, now: string): Promise<boolean> {
    const result = this.#db
      .query("UPDATE run_controls SET heartbeat_at = ? WHERE run_id = ? AND owner = ?")
      .run(now, runId, owner);
    return result.changes > 0;
  }

  async releaseRunLease(runId: string, owner: string): Promise<void> {
    this.#db
      .query("UPDATE run_controls SET owner = NULL, heartbeat_at = NULL WHERE run_id = ? AND owner = ?")
      .run(runId, owner);
  }

  /** Records a pause or cancel request for whichever process owns the run. */
  async requestRunControl(runId: string, kind: "pause" | "cancel"): Promise<void> {
    const column = kind === "pause" ? "pause_requested" : "cancel_requested";
    this.#db.transaction(() => {
      this.#db.query("INSERT OR IGNORE INTO run_controls(run_id) VALUES (?)").run(runId);
      this.#db.query(`UPDATE run_controls SET ${column} = 1 WHERE run_id = ?`).run(runId);
    })();
  }

  async getRunControl(runId: string): Promise<RunControl | undefined> {
    const row = this.#db.query("SELECT * FROM run_controls WHERE run_id = ?").get(runId) as ControlRow | null;
    if (!row) return undefined;
    return {
      runId: row.run_id,
      ...(row.owner === null ? {} : { owner: row.owner }),
      ...(row.heartbeat_at === null ? {} : { heartbeatAt: row.heartbeat_at }),
      pauseRequested: row.pause_requested === 1,
      cancelRequested: row.cancel_requested === 1,
      ...(row.checkpoint === null ? {} : { checkpoint: parse<unknown>(row.checkpoint) }),
    };
  }

  /** Applies run, checkpoint, approval, and event changes together, only while owner holds the lease. */
  async commitRun(runId: string, owner: string, commit: RunCommit): Promise<void> {
    this.#db.transaction(() => {
      const row = this.#db.query("SELECT owner FROM run_controls WHERE run_id = ?").get(runId) as {
        owner: string | null;
      } | null;
      if (row?.owner !== owner) throw new Error(`Run ${runId} lease is not held by this runtime`);
      if (commit.run) {
        if (commit.run.id !== runId) throw new Error("Committed run does not match lease");
        this.#updateRun(commit.run);
      }
      if (commit.checkpoint !== undefined) {
        this.#db
          .query("UPDATE run_controls SET checkpoint = ? WHERE run_id = ?")
          .run(json(commit.checkpoint, this.#options), runId);
      }
      if (commit.approval) {
        if (commit.approval.runId !== runId) throw new Error("Committed approval does not match lease");
        const result = this.#db
          .query(
            `INSERT INTO approvals(id, run_id, status, created_at, data) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data
          WHERE approvals.run_id = excluded.run_id AND approvals.created_at = excluded.created_at`,
          )
          .run(
            commit.approval.id,
            runId,
            commit.approval.status,
            commit.approval.createdAt,
            json(commit.approval, this.#options),
          );
        // An approval's run and creation time are immutable; a mismatched update must not vanish silently.
        if (result.changes === 0) throw new Error(`Approval ${commit.approval.id} belongs to a different request`);
      }
      for (const kind of commit.clearControls ?? []) {
        const column = kind === "pause" ? "pause_requested" : "cancel_requested";
        this.#db.query(`UPDATE run_controls SET ${column} = 0 WHERE run_id = ?`).run(runId);
      }
      for (const event of commit.events ?? []) this.#appendEvent(event);
    })();
  }

  async getApproval(id: string): Promise<ApprovalRequest | undefined> {
    const row = this.#db.query("SELECT data FROM approvals WHERE id = ?").get(id) as JsonRow | null;
    return row ? parse<ApprovalRequest>(row.data) : undefined;
  }

  async listApprovals(runId: string, status?: ApprovalRequest["status"]): Promise<ApprovalRequest[]> {
    const rows = status
      ? this.#db
          .query("SELECT data FROM approvals WHERE run_id = ? AND status = ? ORDER BY created_at, id")
          .all(runId, status)
      : this.#db.query("SELECT data FROM approvals WHERE run_id = ? ORDER BY created_at, id").all(runId);
    return (rows as JsonRow[]).map((row) => parse<ApprovalRequest>(row.data));
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

  /** Append-only canonical run state. The ordinal preserves insertion order across restarts. */
  async append(chunk: StateChunk): Promise<void> {
    this.#requireStateSchema();
    if (!chunk.id || !chunk.runId) throw new Error("State chunks require an id and runId");
    this.#db
      .query("INSERT INTO state_chunks(id, run_id, type, created_at, data) VALUES (?, ?, ?, ?, ?)")
      .run(chunk.id, chunk.runId, chunk.type, chunk.createdAt, json(chunk, this.#options));
  }

  async get(id: string): Promise<StateChunk | undefined> {
    this.#requireStateSchema();
    const row = this.#db.query("SELECT data FROM state_chunks WHERE id = ?").get(id) as JsonRow | null;
    return row ? parse<StateChunk>(row.data) : undefined;
  }

  async list(
    runId: string,
    options: { types?: StateChunkType[]; ids?: string[]; limit?: number } = {},
  ): Promise<StateChunk[]> {
    this.#requireStateSchema();
    const limit = options.limit ?? 500;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1_000) {
      throw new Error("State chunk limit must be an integer from 0 to 1000");
    }
    if (options.ids && options.ids.length > 1_000) {
      throw new Error("State chunk ID filter exceeds 1000 IDs");
    }
    if (limit === 0 || options.types?.length === 0 || options.ids?.length === 0) return [];
    const types = options.types;
    const ids = options.ids;
    const clauses = ["run_id = ?"];
    const args: Array<string | number> = [runId];
    if (types) {
      clauses.push(`type IN (${types.map(() => "?").join(",")})`);
      args.push(...types);
    }
    if (ids) {
      clauses.push(`id IN (${ids.map(() => "?").join(",")})`);
      args.push(...ids);
    }
    const rows = this.#db
      .query(`SELECT data FROM state_chunks WHERE ${clauses.join(" AND ")} ORDER BY ordinal DESC LIMIT ?`)
      .all(...args, limit);
    return (rows as JsonRow[]).reverse().map((row) => parse<StateChunk>(row.data));
  }

  /** Records an exact bounded snapshot of the context sent to the next operation. */
  async recordContextAssembly(
    request: ContextAssemblyRequest,
    assembly: ContextAssembly,
    identity: { id?: string; createdAt?: string } = {},
  ): Promise<ContextAssemblyRecord> {
    this.#requireStateSchema();
    const hash = createHash("sha256").update(assembly.summary).digest("hex");
    if (hash !== assembly.renderedContentHash) throw new Error("Context assembly hash does not match summary");
    const sanitizedSummary = json(assembly.summary, this.#options);
    if (parse<string>(sanitizedSummary) !== assembly.summary) {
      throw new Error("Context summary contains redacted or truncated content");
    }
    if (assembly.chunks.length > 1_000) throw new Error("Context assembly selects too many chunks");
    const selectedChunks = assembly.chunks.map(({ chunk, visibility }) => ({ chunkId: chunk.id, visibility }));
    if (new Set(selectedChunks.map((item) => item.chunkId)).size !== selectedChunks.length) {
      throw new Error("Context assembly selects a chunk more than once");
    }
    const selectedJson = JSON.stringify(selectedChunks);
    if (Buffer.byteLength(selectedJson, "utf8") > (this.#options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES)) {
      throw new Error("Context assembly selection exceeds configured size limit");
    }
    const record: ContextAssemblyRecord = {
      id: identity.id ?? randomUUID(),
      runId: request.runId,
      purpose: request.purpose,
      createdAt: identity.createdAt ?? new Date().toISOString(),
      selectedChunks,
      summary: assembly.summary,
      renderedContentHash: hash,
    };
    this.#db.transaction(() => {
      for (const item of selectedChunks) {
        const row = this.#db
          .query("SELECT 1 FROM state_chunks WHERE id = ? AND run_id = ?")
          .get(item.chunkId, request.runId);
        if (!row) throw new Error(`Context chunk ${item.chunkId} does not belong to run ${request.runId}`);
      }
      this.#db
        .query(
          `INSERT INTO context_assemblies
        (id, run_id, purpose, created_at, selected_chunks, rendered_summary, rendered_content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(record.id, record.runId, record.purpose, record.createdAt, selectedJson, assembly.summary, hash);
    })();
    return record;
  }

  async getContextAssembly(id: string): Promise<ContextAssemblyRecord | undefined> {
    this.#requireStateSchema();
    const row = this.#db
      .query(
        `SELECT id, run_id, purpose, created_at, selected_chunks, rendered_summary,
      rendered_content_hash FROM context_assemblies WHERE id = ?`,
      )
      .get(id) as ContextRow | null;
    return row ? contextRecord(row) : undefined;
  }

  async listContextAssemblies(runId: string, limit = 100): Promise<ContextAssemblyRecord[]> {
    this.#requireStateSchema();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Context assembly limit must be an integer from 1 to 1000");
    }
    const rows = this.#db
      .query(
        `SELECT id, run_id, purpose, created_at, selected_chunks, rendered_summary,
      rendered_content_hash FROM context_assemblies WHERE run_id = ?
      ORDER BY ordinal DESC LIMIT ?`,
      )
      .all(runId, limit) as ContextRow[];
    return rows.reverse().map(contextRecord);
  }

  #requireStateSchema(): void {
    if (this.#schemaVersion < 2) {
      throw new Error("State and context queries require database schema version 2");
    }
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

function contextRecord(row: ContextRow): ContextAssemblyRecord {
  return {
    id: row.id,
    runId: row.run_id,
    purpose: row.purpose,
    createdAt: row.created_at,
    selectedChunks: parse<ContextAssemblyRecord["selectedChunks"]>(row.selected_chunks),
    summary: row.rendered_summary,
    renderedContentHash: row.rendered_content_hash,
  };
}

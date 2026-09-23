import { existsSync } from "node:fs";
import type { HarnessRun, RunId, RunStatus } from "@adaptive-harness/core";
import { SqliteHarnessStore } from "@adaptive-harness/persistence";
import type { EventEnvelope, HarnessRuntime } from "@adaptive-harness/protocol";

/** The read operations of HarnessRuntime available before orchestration lands. */
export interface RunReader extends Pick<HarnessRuntime, "getRun" | "listRuns"> {
  listEvents(runId: RunId, afterSequence?: number, limit?: number): Promise<EventEnvelope[]>;
  close(): void;
}

/** Keeps CLI run queries behind the runtime package boundary. */
export class SqliteRunReader implements RunReader {
  private constructor(private readonly store: SqliteHarnessStore) {}

  static open(databasePath: string): SqliteRunReader {
    if (!existsSync(databasePath)) throw new Error(`Run database not found: ${databasePath}`);
    return new SqliteRunReader(new SqliteHarnessStore(databasePath, { readonly: true }));
  }

  async getRun(runId: RunId): Promise<HarnessRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  listRuns(options?: { limit?: number; status?: RunStatus }): Promise<HarnessRun[]> {
    return this.store.listRuns(options);
  }

  listEvents(runId: RunId, afterSequence?: number, limit?: number): Promise<EventEnvelope[]> {
    return this.store.listEvents(runId, afterSequence, limit);
  }

  close(): void {
    this.store.close();
  }
}

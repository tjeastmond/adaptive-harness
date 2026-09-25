import type { HarnessRun, Objective, RunId, RunStatus, TaskId } from "@adaptive-harness/core";
import type { EventEnvelope, HarnessEvent } from "./events.ts";

export interface CreateRunInput {
  objective: Objective;
  workspace: string;
  configPath: string;
  idempotencyKey?: string;
}

export interface ApprovalRequest {
  id: string;
  runId: RunId;
  taskId?: TaskId;
  kind: "clarification" | "permission" | "risk-acceptance";
  prompt: string;
  choices?: string[];
  status: "pending" | "answered" | "cancelled";
  answer?: string;
  createdAt: string;
  answeredAt?: string;
}

export interface HarnessRuntime {
  createRun(input: CreateRunInput): Promise<HarnessRun>;
  startRun(runId: RunId): Promise<void>;
  pauseRun(runId: RunId): Promise<void>;
  resumeRun(runId: RunId): Promise<void>;
  cancelRun(runId: RunId): Promise<void>;
  answerApproval(requestId: string, answer: string): Promise<void>;
  getRun(runId: RunId): Promise<HarnessRun>;
  getApproval(requestId: string): Promise<ApprovalRequest | undefined>;
  listRuns(options?: { limit?: number; status?: RunStatus }): Promise<HarnessRun[]>;
  /**
   * Streams persisted events in order. The stream ends once the run is terminal and drained, or once `signal`
   * aborts and every event persisted before the abort has been delivered.
   */
  subscribe(
    runId: RunId,
    afterSequence?: number,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<EventEnvelope<HarnessEvent>>;
}

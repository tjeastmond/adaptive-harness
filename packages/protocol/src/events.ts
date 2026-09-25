import type {
  DecisionPhase,
  DecisionResponse,
  HarnessRun,
  NextAction,
  RunId,
  RunPlan,
  RunStatus,
  TaskId,
  VerificationResult,
  WorkerCallId,
  WorkerResult,
  WorkerStreamEvent,
} from "@adaptive-harness/core";

import type { ApprovalRequest } from "./runtime.ts";

export type HarnessEvent =
  | { type: "run.created"; run: HarnessRun }
  | { type: "run.status-changed"; runId: RunId; from: RunStatus; to: RunStatus }
  | { type: "decision.requested"; runId: RunId; phase: DecisionPhase }
  | { type: "decision.completed"; runId: RunId; decision: DecisionResponse }
  | { type: "decision.bypassed"; runId: RunId; reason: string }
  | { type: "worker.started"; runId: RunId; taskId: TaskId; callId: WorkerCallId }
  | { type: "worker.event"; runId: RunId; callId: WorkerCallId; event: WorkerStreamEvent }
  | { type: "worker.completed"; runId: RunId; taskId: TaskId; result: WorkerResult }
  | { type: "verification.completed"; runId: RunId; result: VerificationResult }
  | { type: "policy.action"; runId: RunId; action: NextAction; reasonCodes: string[] }
  | { type: "approval.requested"; request: ApprovalRequest }
  | { type: "approval.answered"; request: ApprovalRequest }
  | { type: "run.paused"; runId: RunId; reason: string }
  | { type: "run.resumed"; runId: RunId }
  | { type: "run.cancelled"; runId: RunId; reason?: string }
  | { type: "run.planned"; runId: RunId; plan: RunPlan }
  | { type: "run.completed"; run: HarnessRun }
  | { type: "run.failed"; run: HarnessRun; error: string };

export interface EventSink {
  append(event: EventEnvelope): Promise<void>;
}

export interface EventEnvelope<T extends HarnessEvent = HarnessEvent> {
  id: string;
  version: 1;
  sequence: number;
  runId: RunId;
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  payload: T;
}

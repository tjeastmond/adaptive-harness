import type { DecisionId, DecisionRequest, DecisionResponse, RunId } from "@adaptive-harness/core";

export type DecisionMode = "jev" | "deterministic";

export interface DecisionContext {
  runId: RunId;
  phase: "route" | "completion" | "handoff" | "context" | "tool" | "permission" | "delegation";
  mode?: DecisionMode;
  reason?: string;
}

export interface DecisionGateway {
  evaluate(context: DecisionContext, request: DecisionRequest): Promise<DecisionResponse>;
}

/** Default decision engine; deterministic mode is an explicit bypass only. */
export const DEFAULT_DECISION_MODE: DecisionMode = "jev";

export type { DecisionId };

import type { DecisionMode, DecisionPhase, DecisionRequest, DecisionResponse, RunId } from "@adaptive-harness/core";

export type { DecisionMode };

export interface DecisionContext {
  runId: RunId;
  phase: DecisionPhase;
  mode?: DecisionMode;
  reason?: string;
}

export interface DecisionGateway {
  evaluate(context: DecisionContext, request: DecisionRequest): Promise<DecisionResponse>;
}

/** Default decision engine; deterministic mode is an explicit bypass only. */
export const DEFAULT_DECISION_MODE: DecisionMode = "jev";

import { createHash } from "node:crypto";
import type { DecisionProvider, DecisionRequest, DecisionResponse, RunId } from "@adaptive-harness/core";
import { JevUnavailableError } from "./jev.ts";
import { DEFAULT_DECISION_MODE, type DecisionContext, type DecisionGateway, type DecisionMode } from "./types.ts";

export type FallbackAction = "deterministic" | "ask-user" | "fail";

export interface DecisionAudit {
  runId: RunId;
  phase: DecisionContext["phase"];
  requestedMode: DecisionMode;
  selectedMode: DecisionMode;
  requestStateHash: string;
  questions: DecisionRequest["questions"];
  createdAt: string;
  response?: DecisionResponse;
  fallbackReason?: string;
  /** The Jev answer that triggered a low-confidence fallback, if any. */
  previousResponse?: DecisionResponse;
  errorCode?: "jev-invalid" | "deterministic-failed";
}

export interface GatewayOptions {
  jev: DecisionProvider;
  deterministic: DecisionProvider;
  allowBypass: boolean;
  fallback: { onUnavailable: FallbackAction; onLowConfidence: FallbackAction };
  minConfidence: number;
  /** Required audit sink; runtime can persist this through its repository boundary. */
  record: (audit: DecisionAudit) => Promise<void>;
  /** Required event sink for observable deterministic bypasses. */
  emitBypass: (event: { runId: RunId; reason: string }) => Promise<void>;
}

export class DecisionHandoffError extends Error {
  constructor(
    readonly action: "ask-user" | "fail",
    readonly reason: string,
  ) {
    super(`Decision ${action}: ${reason}`);
  }
}

function lowConfidence(response: DecisionResponse, threshold: number): boolean {
  return Object.values(response.answers).some(
    (answer) => (answer.type === "choice" || answer.type === "score") && answer.confidence < threshold,
  );
}

export class DefaultDecisionGateway implements DecisionGateway {
  constructor(private readonly options: GatewayOptions) {
    if (options.jev.kind !== "jev" || options.deterministic.kind !== "deterministic") {
      throw new Error("Decision gateway providers have incorrect kinds");
    }
    if (!Number.isFinite(options.minConfidence) || options.minConfidence < 0 || options.minConfidence > 1) {
      throw new Error("Decision confidence threshold must be from 0 to 1");
    }
  }

  async evaluate(context: DecisionContext, request: DecisionRequest): Promise<DecisionResponse> {
    const requestedMode = context.mode ?? DEFAULT_DECISION_MODE;
    const base = {
      runId: context.runId,
      phase: context.phase,
      requestedMode,
      requestStateHash: createHash("sha256").update(request.state).digest("hex"),
      questions: structuredClone(request.questions),
      createdAt: new Date().toISOString(),
    };
    if (requestedMode === "deterministic") {
      if (!this.options.allowBypass) throw new DecisionHandoffError("fail", "bypass-disabled");
      return this.#bypass(context, request, { ...base, selectedMode: "deterministic" }, context.reason ?? "explicit");
    }

    let response: DecisionResponse;
    try {
      response = await this.options.jev.evaluate(request);
    } catch (error) {
      if (!(error instanceof JevUnavailableError)) {
        await this.options.record({ ...base, selectedMode: "jev", errorCode: "jev-invalid" });
        throw error;
      }
      return this.#fallback(context, request, base, this.options.fallback.onUnavailable, "jev-unavailable");
    }
    if (lowConfidence(response, this.options.minConfidence)) {
      return this.#fallback(context, request, base, this.options.fallback.onLowConfidence, "low-confidence", response);
    }
    await this.options.record({ ...base, selectedMode: "jev", response });
    return response;
  }

  async #fallback(
    context: DecisionContext,
    request: DecisionRequest,
    base: Omit<DecisionAudit, "selectedMode">,
    action: FallbackAction,
    reason: "jev-unavailable" | "low-confidence",
    jevResponse?: DecisionResponse,
  ): Promise<DecisionResponse> {
    if (action === "deterministic" && this.options.allowBypass) {
      return this.#bypass(context, request, { ...base, selectedMode: "deterministic" }, reason, jevResponse);
    }
    const handoff = action === "ask-user" ? "ask-user" : "fail";
    await this.options.record({
      ...base,
      selectedMode: "jev",
      fallbackReason: reason,
      ...(jevResponse ? { response: jevResponse } : {}),
    });
    throw new DecisionHandoffError(handoff, reason);
  }

  async #bypass(
    context: DecisionContext,
    request: DecisionRequest,
    base: DecisionAudit,
    reason: string,
    previousResponse?: DecisionResponse,
  ): Promise<DecisionResponse> {
    await this.options.emitBypass({ runId: context.runId, reason });
    try {
      const response = await this.options.deterministic.evaluate(request);
      await this.options.record({
        ...base,
        response,
        fallbackReason: reason,
        ...(previousResponse ? { previousResponse } : {}),
      });
      return response;
    } catch (error) {
      await this.options.record({
        ...base,
        fallbackReason: reason,
        ...(previousResponse ? { previousResponse } : {}),
        errorCode: "deterministic-failed",
      });
      throw error;
    }
  }
}

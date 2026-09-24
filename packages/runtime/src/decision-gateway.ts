import { randomUUID } from "node:crypto";
import {
  type DecisionAudit,
  type DecisionGateway,
  DefaultDecisionGateway,
  type GatewayOptions,
} from "@adaptive-harness/decisions";
import type { SqliteHarnessStore } from "@adaptive-harness/persistence";
import type { HarnessEvent } from "@adaptive-harness/protocol";

type BypassEvent = Extract<HarnessEvent, { type: "decision.bypassed" }>;

/** Connect the decision plane to durable audit records and the runtime event stream. */
export function createPersistentDecisionGateway(
  store: SqliteHarnessStore,
  options: Omit<GatewayOptions, "record" | "emitBypass"> & {
    emit: (event: BypassEvent) => Promise<void>;
  },
): DecisionGateway {
  const record = async (audit: DecisionAudit): Promise<void> => {
    await store.saveDecision({
      id: audit.response?.id ?? randomUUID(),
      runId: audit.runId,
      createdAt: audit.createdAt,
      phase: audit.phase as "route" | "completion",
      requestStateHash: audit.requestStateHash,
      questions: audit.questions,
      ...(audit.response ? { response: audit.response } : {}),
      requestedMode: audit.requestedMode,
      selectedMode: audit.selectedMode,
      ...(audit.fallbackReason ? { fallbackReason: audit.fallbackReason } : {}),
      ...(audit.previousResponse ? { previousResponse: audit.previousResponse } : {}),
      ...(audit.errorCode ? { errorCode: audit.errorCode } : {}),
    });
  };
  const gateway = new DefaultDecisionGateway({
    ...options,
    record,
    emitBypass: async ({ runId, reason }) => options.emit({ type: "decision.bypassed", runId, reason }),
  });
  return {
    async evaluate(context, request) {
      if (context.phase !== "route" && context.phase !== "completion") {
        throw new Error(`Unsupported persisted decision phase ${context.phase}`);
      }
      return gateway.evaluate(context, request);
    },
  };
}

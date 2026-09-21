import { describe, expect, test } from "bun:test";
import type { RunStatus } from "@adaptive-harness/core";
import { DEFAULT_DECISION_MODE } from "@adaptive-harness/decisions";
import { type EventEnvelope, type HarnessEvent, PROTOCOL_VERSION } from "@adaptive-harness/protocol";

describe("adaptive-harness workspace", () => {
  test("core and protocol types compose", () => {
    const status: RunStatus = "created";
    const envelope: EventEnvelope<HarnessEvent> = {
      id: "evt-1",
      version: 1,
      sequence: 1,
      runId: "run-1",
      occurredAt: new Date().toISOString(),
      correlationId: "corr-1",
      payload: {
        type: "run.paused",
        runId: "run-1",
        reason: "bootstrap test",
      },
    };

    expect(status).toBe("created");
    expect(envelope.payload.type).toBe("run.paused");
    expect(PROTOCOL_VERSION).toBe(1);
    expect(DEFAULT_DECISION_MODE).toBe("jev");
  });
});

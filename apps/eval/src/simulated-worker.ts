import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FileChange, WorkerAdapter, WorkerRequest, WorkerResult, WorkerStreamEvent } from "@adaptive-harness/core";

/** File contents a simulated worker writes on one write attempt. */
export interface SimulatedAttempt {
  files: Record<string, string>;
  summary?: string;
}

/** A scripted solution: attempt N applies `attempts[N - 1]`, and later attempts reuse the last one. */
export interface SimulatedSolution {
  attempts: SimulatedAttempt[];
}

/** Rough token estimate for text, about four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * A worker that applies a task's scripted solution instead of calling a provider. It exercises the harness's
 * routing, verification, retry, and approval paths without spending worker tokens; its usage is an estimate.
 */
export class SimulatedWorker implements WorkerAdapter {
  readonly requests: WorkerRequest[] = [];
  #writes = 0;

  constructor(
    readonly kind: "codex-cli" | "cursor-cli",
    private readonly solution: SimulatedSolution,
  ) {}

  async preflight() {
    return { ok: true, version: "simulated", details: ["Simulated worker; no provider is called"] };
  }

  async cancel(): Promise<void> {}

  async execute(request: WorkerRequest, emit: (event: WorkerStreamEvent) => void | Promise<void>) {
    this.requests.push(request);
    const id = `simulated-${crypto.randomUUID()}`;
    const startedAt = new Date().toISOString();
    await emit({ type: "session.started", callId: id, at: startedAt });

    const filesChanged: FileChange[] = [];
    let summary: string;
    let written = "";
    if (request.task.access.mode === "read") {
      summary = "Reviewed the change; no concerns.";
    } else {
      const attempt = this.solution.attempts[Math.min(this.#writes, this.solution.attempts.length - 1)];
      this.#writes += 1;
      for (const [path, content] of Object.entries(attempt?.files ?? {})) {
        const target = join(request.workspace, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
        filesChanged.push({ path, status: "modified" });
        written += content;
      }
      summary = attempt?.summary ?? `Updated ${filesChanged.map((file) => file.path).join(", ")}.`;
    }
    const finalOutput = written ? `${summary}\n${written}` : summary;
    const usage = { inputTokens: estimateTokens(request.instructions), outputTokens: estimateTokens(finalOutput) };
    const finishedAt = new Date().toISOString();
    await emit({ type: "message", role: "assistant", text: summary, at: finishedAt });
    await emit({ type: "usage", usage, at: finishedAt });
    return {
      id,
      provider: this.kind,
      status: "succeeded",
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      exitCode: 0,
      report: { summary, completed: true, filesChanged, checksRun: [], concerns: [] },
      finalOutput,
      usage,
      rawEventCount: 0,
    } satisfies WorkerResult;
  }
}

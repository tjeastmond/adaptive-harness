import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { HarnessConfig } from "@adaptive-harness/config";
import {
  assertTransition,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResponse,
  type HarnessRun,
  type HarnessTask,
  isTerminalStatus,
  type NextAction,
  type RunId,
  type RunStatus,
  type StateChunk,
  type TaskKind,
  type Usage,
  type VerificationResult,
  type WorkerAdapter,
  type WorkerRequest,
  type WorkerResult,
} from "@adaptive-harness/core";
import {
  completionRequest,
  DecisionHandoffError,
  type DecisionMode,
  DeterministicDecisionProvider,
  exhaustedBudget,
  normalizeCompletionDecision,
  normalizeRouteDecision,
  routeRequest,
  selectInitialAgent,
  selectNextAction,
} from "@adaptive-harness/decisions";
import { RecordingContextAssembler, type RunCommit, type SqliteHarnessStore } from "@adaptive-harness/persistence";
import type {
  ApprovalRequest,
  CreateRunInput,
  EventEnvelope,
  HarnessEvent,
  HarnessRuntime,
} from "@adaptive-harness/protocol";
import { CodexWorkerAdapter, CursorWorkerAdapter } from "@adaptive-harness/workers";
import { captureGitState, compareGitStates, type GitState, preflightRepository } from "@adaptive-harness/workspace";
import { createPersistentDecisionGateway } from "./decision-gateway.ts";
import { verifyWorkspace } from "./verification.ts";

type Phase = "route" | "work" | "verify" | "complete" | "await-approval" | "answered";
type Role = "implementation" | "review";
type Stop = "lease" | "cancel" | "budget" | "pause";

/** Durable position of a run. A worker call recorded in `inFlight` is never started again. */
export interface RunCheckpoint {
  version: 1;
  phase: Phase;
  attempt: number;
  retries: number;
  taskKind?: TaskKind;
  taskId?: string;
  implementationTaskId?: string;
  role?: Role;
  agentName?: string;
  implementationAgent?: string;
  /** Workspace state immediately before the current worker call. */
  baseline?: GitState;
  /** Workspace state last observed by the harness; later drift is an out-of-band change. */
  observed?: GitState;
  inFlight?: { taskId: string; callId?: string };
  verification?: VerificationResult;
  reviewCompletedForAttempt: boolean;
  editsSinceReview: boolean;
  approval?: {
    id: string;
    resume: "route-clarification" | "route-handoff" | "completion";
    agentName?: string;
    answer?: string;
  };
}

export interface LocalRuntimeOptions {
  config: { path: string; config: HarnessConfig; hash: string };
  store: SqliteHarnessStore;
  jev: DecisionProvider;
  deterministic?: DecisionProvider;
  /** Overrides `decision.mode`; a deterministic mode is recorded as an observable bypass. */
  decisionMode?: DecisionMode;
  decisionReason?: string;
  /** Worker adapters keyed by provider name. Defaults to adapters built from the config. */
  workers?: Record<string, WorkerAdapter>;
  environment?: Record<string, string>;
  now?: () => number;
  owner?: string;
  pollIntervalMs?: number;
  leaseTimeoutMs?: number;
}

interface Drive {
  run: HarnessRun;
  cp: RunCheckpoint;
  /** Clock reading already charged to `budget.elapsedMs`. */
  tick: number;
  /** Idle control changes, such as cancelling a paused run, do not consume active time. */
  timed: boolean;
  queue: Promise<unknown>;
  abort: AbortController;
  stop?: { kind: Stop; reason: string };
}

/** The caller asked for an operation the run cannot accept; the run itself is unchanged. */
export class RuntimeUsageError extends Error {}
class LeaseUnavailableError extends RuntimeUsageError {}
class LeaseLostError extends Error {}

const STOP_PRIORITY: Record<Stop, number> = { pause: 1, budget: 2, cancel: 3, lease: 4 };
const COMPLETION_CHOICES = ["retry", "review", "done", "fail"] as const;
const ROLE_INSTRUCTIONS: Record<Role, string> = {
  implementation:
    "Implement the objective in this workspace. Keep the change focused, and report what you changed and verified.",
  review:
    "Review the current workspace changes against the objective. Do not modify files. Report concerns and whether the objective is satisfied.",
};

const iso = (ms: number) => new Date(ms).toISOString();
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function initialCheckpoint(): RunCheckpoint {
  return {
    version: 1,
    phase: "route",
    attempt: 1,
    retries: 0,
    reviewCompletedForAttempt: false,
    editsSinceReview: false,
  };
}

function statusForPhase(cp: RunCheckpoint): RunStatus | undefined {
  if (cp.phase === "route") return "routing";
  if (cp.phase === "work") return cp.role === "review" ? "reviewing" : "running";
  if (cp.phase === "verify" || cp.phase === "complete") return "verifying";
  return undefined;
}

function defaultWorkers(config: HarnessConfig): Record<string, WorkerAdapter> {
  return Object.fromEntries(
    Object.entries(config.providers).map(([name, provider]) => {
      const options = { command: provider.command, model: provider.model, extraArgs: provider.extraArgs };
      return [name, provider.kind === "codex-cli" ? new CodexWorkerAdapter(options) : new CursorWorkerAdapter(options)];
    }),
  );
}

function withoutInFlight(cp: RunCheckpoint): RunCheckpoint {
  const { inFlight: _inFlight, ...rest } = cp;
  return rest;
}

/**
 * Local, single-writer orchestrator. Each run is driven by whichever runtime holds its lease, and every
 * state change is committed atomically with its events and checkpoint so a restart resumes at the last
 * committed phase without starting a completed or interrupted worker call again.
 */
export class LocalHarnessRuntime implements HarnessRuntime {
  readonly #store: SqliteHarnessStore;
  readonly #config: LocalRuntimeOptions["config"];
  readonly #gateway;
  readonly #context: RecordingContextAssembler;
  readonly #workers: Record<string, WorkerAdapter>;
  readonly #environment: Record<string, string>;
  readonly #now: () => number;
  readonly #owner: string;
  readonly #pollMs: number;
  readonly #leaseTimeoutMs: number;
  readonly #mode: DecisionMode;
  readonly #modeReason: string | undefined;
  readonly #drives = new Map<RunId, Drive>();
  readonly #active = new Map<RunId, Promise<void>>();

  constructor(options: LocalRuntimeOptions) {
    const config = options.config.config;
    this.#store = options.store;
    this.#config = options.config;
    this.#workers = options.workers ?? defaultWorkers(config);
    this.#environment = options.environment ?? {};
    this.#now = options.now ?? Date.now;
    this.#owner = options.owner ?? `runtime-${randomUUID()}`;
    this.#pollMs = options.pollIntervalMs ?? 1_000;
    this.#leaseTimeoutMs = options.leaseTimeoutMs ?? 30_000;
    if (this.#leaseTimeoutMs <= this.#pollMs * 2) throw new Error("Lease timeout must exceed two poll intervals");
    this.#mode = options.decisionMode ?? config.decision.mode;
    this.#modeReason = options.decisionReason ?? (this.#mode === "deterministic" ? "configured" : undefined);
    this.#context = new RecordingContextAssembler(options.store);
    this.#gateway = createPersistentDecisionGateway(options.store, {
      jev: options.jev,
      deterministic: options.deterministic ?? new DeterministicDecisionProvider(),
      allowBypass: config.decision.allowBypass,
      fallback: config.decision.fallback,
      minConfidence: config.routing.askUserBelowConfidence,
      emit: async (event) => {
        const drive = this.#drives.get(event.runId);
        if (!drive) throw new Error(`Run ${event.runId} is not active in this runtime`);
        await this.#commit(drive, [event]);
      },
    });
  }

  get #settings(): HarnessConfig {
    return this.#config.config;
  }

  async createRun(input: CreateRunInput): Promise<HarnessRun> {
    if (resolve(input.configPath) !== this.#config.path) {
      throw new RuntimeUsageError(`Run config ${input.configPath} does not match the runtime config`);
    }
    const id = input.idempotencyKey
      ? `run-${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 24)}`
      : `run-${randomUUID()}`;
    const existing = input.idempotencyKey ? await this.#store.getRun(id) : undefined;
    if (existing) return existing;
    const at = iso(this.#now());
    const run: HarnessRun = {
      id,
      status: "created",
      objective: structuredClone(input.objective),
      workspace: resolve(input.workspace),
      configPath: this.#config.path,
      configHash: this.#config.hash,
      currentStep: 0,
      budget: { workerCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, elapsedMs: 0 },
      createdAt: at,
      updatedAt: at,
    };
    await this.#store.createRun(run);
    if (input.objective.suppliedContext) {
      await this.#store.append({
        id: `${id}:supplied-context`,
        runId: id,
        type: "user-message",
        source: "objective",
        createdAt: at,
        metadata: {},
        content: input.objective.suppliedContext,
      });
    }
    await this.#store.appendEvent({
      id: randomUUID(),
      version: 1,
      sequence: 1,
      runId: id,
      occurredAt: at,
      correlationId: id,
      payload: { type: "run.created", run },
    });
    return run;
  }

  /** Resolves once the run is terminal, paused, or waiting for an approval. */
  async startRun(runId: RunId): Promise<void> {
    const run = await this.getRun(runId);
    if (run.status !== "created") throw new RuntimeUsageError(`Run ${runId} has already started`);
    if (run.configHash !== this.#config.hash) throw new RuntimeUsageError(`Run ${runId} config changed since creation`);
    await this.#exclusive(runId, async (drive) => {
      if (drive.run.status !== "created") throw new RuntimeUsageError(`Run ${runId} has already started`);
      const preflight = await preflightRepository(drive.run.workspace, this.#settings.git);
      if (!preflight.ok || !preflight.state) {
        await this.#fail(drive, preflight.reasons.join("; ") || "The runtime requires a Git repository");
        return;
      }
      drive.cp = { ...drive.cp, observed: preflight.state };
      await this.#transition(drive, "routing");
      await this.#loop(drive);
    });
  }

  async pauseRun(runId: RunId): Promise<void> {
    const run = await this.getRun(runId);
    if (isTerminalStatus(run.status)) throw new RuntimeUsageError(`Run ${runId} is ${run.status}`);
    if (run.status === "created") throw new RuntimeUsageError(`Run ${runId} has not started`);
    if (run.status === "paused") return;
    await this.#requestControl(runId, "pause");
  }

  async cancelRun(runId: RunId): Promise<void> {
    const run = await this.getRun(runId);
    if (run.status === "cancelled") return;
    if (isTerminalStatus(run.status)) throw new RuntimeUsageError(`Run ${runId} is ${run.status}`);
    await this.#requestControl(runId, "cancel");
  }

  async resumeRun(runId: RunId): Promise<void> {
    const run = await this.getRun(runId);
    if (run.status !== "paused") throw new RuntimeUsageError(`Run ${runId} is ${run.status}, not paused`);
    const [pending] = await this.#store.listApprovals(runId, "pending");
    if (pending) throw new RuntimeUsageError(`Run ${runId} is waiting for approval ${pending.id}`);
    await this.#exclusive(runId, async (drive) => {
      if (drive.run.status !== "paused") throw new RuntimeUsageError(`Run ${runId} is not paused`);
      if (drive.cp.phase === "await-approval") throw new RuntimeUsageError(`Run ${runId} is waiting for approval`);
      const to = statusForPhase(drive.cp);
      const events: HarnessEvent[] = [{ type: "run.resumed", runId }];
      if (to) await this.#transition(drive, to, events, { clearControls: ["pause"] });
      else await this.#commit(drive, events, { clearControls: ["pause"] });
      await this.#loop(drive);
    });
  }

  async answerApproval(requestId: string, answer: string): Promise<void> {
    const approval = await this.#store.getApproval(requestId);
    if (!approval) throw new RuntimeUsageError(`Approval not found: ${requestId}`);
    if (approval.status !== "pending") throw new RuntimeUsageError(`Approval ${requestId} is ${approval.status}`);
    if (!answer.trim()) throw new RuntimeUsageError("Approval answer must not be empty");
    if (approval.choices && !approval.choices.includes(answer)) {
      throw new RuntimeUsageError(`Answer must be one of: ${approval.choices.join(", ")}`);
    }
    await this.#exclusive(approval.runId, async (drive) => {
      const pending = drive.cp.approval;
      if (drive.run.status !== "paused" || drive.cp.phase !== "await-approval" || pending?.id !== requestId) {
        throw new RuntimeUsageError(`Approval ${requestId} is not awaiting an answer`);
      }
      const at = iso(this.#now());
      const answered: ApprovalRequest = { ...approval, status: "answered", answer, answeredAt: at };
      await this.#appendOnce({
        id: `${requestId}:answer`,
        runId: drive.run.id,
        type: "user-message",
        source: "approval",
        createdAt: at,
        metadata: { approvalId: requestId },
        content: `${approval.prompt}\nAnswer: ${answer}`,
      });
      drive.cp = { ...drive.cp, phase: "answered", approval: { ...pending, answer } };
      await this.#commit(drive, [{ type: "approval.answered", request: answered }], {
        approval: answered,
        clearControls: ["pause"],
      });
      await this.#loop(drive);
    });
  }

  async getRun(runId: RunId): Promise<HarnessRun> {
    const run = await this.#store.getRun(runId);
    if (!run) throw new RuntimeUsageError(`Run not found: ${runId}`);
    return run;
  }

  listRuns(options?: { limit?: number; status?: RunStatus }): Promise<HarnessRun[]> {
    return this.#store.listRuns(options);
  }

  /** Streams persisted events in order and ends after the run is terminal and fully drained. */
  async *subscribe(runId: RunId, afterSequence = 0): AsyncIterable<EventEnvelope<HarnessEvent>> {
    let cursor = afterSequence;
    for (;;) {
      const events = await this.#store.listEvents(runId, cursor, 500);
      for (const event of events) {
        cursor = event.sequence;
        yield event;
      }
      if (events.length === 500) continue;
      const run = await this.getRun(runId);
      if (isTerminalStatus(run.status)) {
        if ((await this.#store.lastEventSequence(runId)) <= cursor) return;
        continue;
      }
      await sleep(this.#pollMs);
    }
  }

  /** Pauses active runs whose owner stopped renewing its lease. Resuming them never restarts a worker call. */
  async recoverInterruptedRuns(): Promise<RunId[]> {
    const recovered: RunId[] = [];
    for (const status of ["routing", "running", "verifying", "reviewing"] as const) {
      for (const run of await this.#store.listRuns({ status, limit: 1000 })) {
        if (this.#active.has(run.id)) continue;
        try {
          await this.#exclusive(
            run.id,
            async (drive) => {
              if (isTerminalStatus(drive.run.status) || drive.run.status === "paused") return;
              await this.#transition(drive, "paused", [
                { type: "run.paused", runId: run.id, reason: "runtime-interrupted" },
              ]);
              recovered.push(run.id);
            },
            false,
          );
        } catch (error) {
          if (!(error instanceof LeaseUnavailableError)) throw error;
        }
      }
    }
    return recovered;
  }

  async #requestControl(runId: RunId, kind: "pause" | "cancel"): Promise<void> {
    await this.#store.requestRunControl(runId, kind);
    const active = this.#active.get(runId);
    if (active) {
      await active.catch(() => undefined);
      return;
    }
    try {
      await this.#exclusive(
        runId,
        async (drive) => {
          await this.#pollControls(drive);
          if (drive.stop) await this.#stop(drive);
        },
        false,
      );
    } catch (error) {
      // A live runtime in another process owns the run and applies the request at its next poll.
      if (!(error instanceof LeaseUnavailableError)) throw error;
    }
  }

  async #exclusive(runId: RunId, body: (drive: Drive) => Promise<void>, timed = true): Promise<void> {
    if (this.#active.has(runId)) throw new LeaseUnavailableError(`Run ${runId} is already active in this runtime`);
    const at = this.#now();
    if (!(await this.#store.acquireRunLease(runId, this.#owner, iso(at), iso(at - this.#leaseTimeoutMs)))) {
      throw new LeaseUnavailableError(`Run ${runId} is active in another runtime`);
    }
    const task = (async () => {
      let drive: Drive | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        drive = await this.#load(runId, timed);
        const current = drive;
        this.#drives.set(runId, current);
        heartbeat = setInterval(() => void this.#heartbeat(current), this.#pollMs);
        await body(current);
        await current.queue;
      } catch (error) {
        if (error instanceof LeaseLostError) return;
        if (error instanceof RuntimeUsageError || !drive || isTerminalStatus(drive.run.status)) throw error;
        try {
          await this.#fail(drive, `Runtime error: ${errorMessage(error)}`);
        } catch (failure) {
          if (!(failure instanceof LeaseLostError)) throw failure;
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        this.#drives.delete(runId);
        await this.#store.releaseRunLease(runId, this.#owner);
      }
    })();
    this.#active.set(runId, task);
    try {
      await task;
    } finally {
      this.#active.delete(runId);
    }
  }

  async #load(runId: RunId, timed: boolean): Promise<Drive> {
    const run = await this.getRun(runId);
    const control = await this.#store.getRunControl(runId);
    const cp = (control?.checkpoint as RunCheckpoint | undefined) ?? initialCheckpoint();
    if (cp.version !== 1) throw new Error(`Unsupported checkpoint version for run ${runId}`);
    return { run, cp, tick: this.#now(), timed, queue: Promise.resolve(), abort: new AbortController() };
  }

  async #heartbeat(drive: Drive): Promise<void> {
    try {
      if (!(await this.#store.renewRunLease(drive.run.id, this.#owner, iso(this.#now())))) {
        this.#requestStop(drive, "lease", "lease-lost");
        return;
      }
      await this.#pollControls(drive);
    } catch {
      // A transient store error is retried at the next poll; a lost lease is detected on renewal or commit.
    }
  }

  async #pollControls(drive: Drive): Promise<void> {
    const control = await this.#store.getRunControl(drive.run.id);
    if (control?.cancelRequested) this.#requestStop(drive, "cancel", "cancel requested");
    else if (control?.pauseRequested) this.#requestStop(drive, "pause", "pause requested");
  }

  #requestStop(drive: Drive, kind: Stop, reason: string): void {
    if (drive.stop && STOP_PRIORITY[drive.stop.kind] >= STOP_PRIORITY[kind]) return;
    drive.stop = { kind, reason };
    drive.abort.abort();
  }

  async #stop(drive: Drive): Promise<void> {
    const stop = drive.stop;
    if (!stop) return;
    if (stop.kind === "lease") throw new LeaseLostError();
    if (stop.kind === "budget") return this.#fail(drive, stop.reason);
    if (stop.kind === "cancel") return this.#cancel(drive);
    await this.#transition(drive, "paused", [{ type: "run.paused", runId: drive.run.id, reason: stop.reason }], {
      clearControls: ["pause"],
    });
  }

  async #loop(drive: Drive): Promise<void> {
    while (!isTerminalStatus(drive.run.status) && drive.cp.phase !== "await-approval") {
      await this.#pollControls(drive);
      if (drive.stop) return this.#stop(drive);
      if (drive.run.status === "paused" && drive.cp.phase !== "answered") return;
      switch (drive.cp.phase) {
        case "route":
          await this.#route(drive);
          break;
        case "work":
          await this.#work(drive);
          break;
        case "verify":
          await this.#verify(drive);
          break;
        case "complete":
          await this.#complete(drive);
          break;
        case "answered":
          await this.#afterApproval(drive);
          break;
      }
    }
  }

  async #route(drive: Drive): Promise<void> {
    const budget = exhaustedBudget(drive.run, this.#settings.limits);
    if (budget) return this.#fail(drive, budget);
    drive.run.currentStep++;
    let response: DecisionResponse;
    try {
      response = await this.#decide(drive, "route", routeRequest);
    } catch (error) {
      if (!(error instanceof DecisionHandoffError)) throw error;
      if (error.action === "fail") return this.#fail(drive, `route decision ${error.reason}`);
      const agents = Object.entries(this.#settings.agents)
        .filter(([, agent]) => agent.purpose === "implementation" && !agent.readOnly)
        .map(([name]) => name);
      return this.#requestApproval(drive, { resume: "route-handoff" }, "clarification", {
        prompt: `Routing needs a decision (${error.reason}). Choose an implementation agent, or fail the run.`,
        choices: [...agents, "fail"],
      });
    }
    const route = normalizeRouteDecision(response, this.#settings.routing);
    drive.cp = { ...drive.cp, taskKind: route.taskKind };
    await this.#appendOnce({
      id: `${drive.run.id}:route:${drive.run.currentStep}`,
      runId: drive.run.id,
      type: "plan",
      source: "route-decision",
      createdAt: iso(this.#now()),
      metadata: { decisionId: response.id },
      content: route,
    });
    const selected = selectInitialAgent(route, this.#settings);
    if (selected === "ask-user") {
      return this.#requestApproval(
        drive,
        { resume: "route-clarification", agentName: route.selectedAgent },
        "clarification",
        {
          prompt: "The objective's requirements are unclear. Clarify them to continue.",
        },
      );
    }
    if (!Object.hasOwn(this.#settings.agents, selected))
      return this.#fail(drive, `Route selected unknown agent ${selected}`);
    await this.#assign(drive, "implementation", selected, route.taskKind);
  }

  async #decide(
    drive: Drive,
    phase: "route" | "completion",
    build: (state: string) => DecisionRequest,
  ): Promise<DecisionResponse> {
    const runId = drive.run.id;
    const context = await this.#context.assemble({ runId, purpose: "decision", objective: drive.run.objective });
    await this.#commit(drive, [{ type: "decision.requested", runId, phase }]);
    const response = await this.#gateway.evaluate(
      { runId, phase, mode: this.#mode, ...(this.#modeReason ? { reason: this.#modeReason } : {}) },
      build(context.summary),
    );
    await this.#commit(drive, [{ type: "decision.completed", runId, decision: response }]);
    return response;
  }

  async #assign(drive: Drive, role: Role, agentName: string, kind: TaskKind, events: HarnessEvent[] = []) {
    const agent = this.#settings.agents[agentName];
    if (!agent) return this.#fail(drive, `Unknown agent ${agentName}`, events);
    const at = iso(this.#now());
    const runId = drive.run.id;
    const task: HarnessTask = {
      id: `${runId}:task:${(await this.#store.listTasks(runId)).length + 1}`,
      runId,
      ...(role === "review" && drive.cp.implementationTaskId ? { parentTaskId: drive.cp.implementationTaskId } : {}),
      kind,
      objective: drive.run.objective,
      attempt: drive.cp.attempt,
      assignedAgent: agentName,
      access: { mode: role === "review" || agent.readOnly ? "read" : "write" },
      status: "pending",
      createdAt: at,
      updatedAt: at,
    };
    await this.#store.saveTask(task);
    drive.cp = {
      ...drive.cp,
      phase: "work",
      role,
      agentName,
      taskId: task.id,
      ...(role === "implementation" ? { implementationAgent: agentName, implementationTaskId: task.id } : {}),
    };
    drive.run.currentTaskId = task.id;
    await this.#transition(drive, role === "review" ? "reviewing" : "running", events);
  }

  async #work(drive: Drive): Promise<void> {
    const { taskId, agentName, role = "implementation" } = drive.cp;
    if (!taskId || !agentName) throw new Error("Work checkpoint has no task");
    if (drive.cp.inFlight) return this.#recoverInterruptedCall(drive);
    const limits = this.#settings.limits;
    const budget = exhaustedBudget(drive.run, limits);
    if (budget) return this.#fail(drive, budget);
    const agent = this.#settings.agents[agentName];
    const adapter = agent && this.#workers[agent.provider];
    if (!agent || !adapter) return this.#fail(drive, `No worker adapter for agent ${agentName}`);
    const task = await this.#store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const baseline = await captureGitState(drive.run.workspace);
    if (drive.cp.observed) {
      const drift = await compareGitStates(drive.cp.observed, baseline);
      if (drift.headChanged || drift.changesSinceBaseline.length) {
        const paths = drift.changesSinceBaseline.map((change) => change.path).slice(0, 20);
        return this.#fail(drive, `Workspace changed outside the harness: ${paths.join(", ") || "HEAD moved"}`);
      }
    }
    const running: HarnessTask = { ...task, status: "running", updatedAt: iso(this.#now()) };
    await this.#store.saveTask(running);
    drive.run.currentStep++;
    drive.run.budget.workerCalls++;
    drive.cp = { ...drive.cp, baseline, inFlight: { taskId } };
    // Persist the call before starting it; after a crash it is recovered, never repeated.
    await this.#commit(drive, []);

    const runId = drive.run.id;
    const context = await this.#context.assemble({
      runId,
      purpose: role === "review" ? "review" : "worker",
      objective: drive.run.objective,
    });
    const request: WorkerRequest = {
      runId,
      task: running,
      agentName,
      instructions: [agent.instructions, ROLE_INSTRUCTIONS[role], context.summary].join("\n\n"),
      workspace: drive.run.workspace,
      readOnly: role === "review" || agent.readOnly,
      timeoutMs: Math.max(1, Math.min(limits.workerTimeoutMs, limits.maxElapsedMs - drive.run.budget.elapsedMs)),
      environment: this.#environment,
    };
    const startBudget = { ...drive.run.budget };
    let callId: string | undefined;
    const cancel = () => {
      if (callId) adapter.cancel(callId).catch(() => undefined);
    };
    drive.abort.signal.addEventListener("abort", cancel);
    let result: WorkerResult;
    try {
      result = await adapter.execute(request, async (event) => {
        if (event.type === "session.started" && event.callId && !callId) {
          callId = event.callId;
          drive.cp = { ...drive.cp, inFlight: { taskId, callId } };
          await this.#commit(drive, [{ type: "worker.started", runId, taskId, callId }]);
          if (drive.abort.signal.aborted) cancel();
          return;
        }
        if (!callId) return;
        if (event.type === "usage") this.#checkStreamedUsage(drive, startBudget, event.usage);
        if (event.type === "provider.raw" && !this.#settings.telemetry.retainRawProviderEvents) return;
        await this.#commit(drive, [{ type: "worker.event", runId, callId, event }]);
      });
    } finally {
      drive.abort.signal.removeEventListener("abort", cancel);
    }
    const model = this.#settings.providers[agent.provider]?.model;
    await this.#store.saveWorkerCall({
      id: result.id,
      runId,
      taskId,
      createdAt: result.startedAt,
      ...(model ? { model } : {}),
      result,
    });
    await this.#finishWork(drive, result);
  }

  /** A streamed usage report beyond a budget stops the call instead of waiting for it to finish. */
  #checkStreamedUsage(drive: Drive, start: HarnessRun["budget"], usage: Usage): void {
    const limits = this.#settings.limits;
    if (start.inputTokens + (usage.inputTokens ?? 0) > limits.maxInputTokens) {
      this.#requestStop(drive, "budget", "token-limit");
    } else if (start.estimatedCostUsd + (usage.estimatedCostUsd ?? 0) > limits.maxCostUsd) {
      this.#requestStop(drive, "budget", "cost-limit");
    }
  }

  async #recoverInterruptedCall(drive: Drive): Promise<void> {
    const inFlight = drive.cp.inFlight;
    if (!inFlight) return;
    const saved = (await this.#store.listWorkerCalls(drive.run.id)).find((call) => call.taskId === inFlight.taskId);
    if (saved) return this.#finishWork(drive, saved.result);
    const at = iso(this.#now());
    const agent = drive.cp.agentName ? this.#settings.agents[drive.cp.agentName] : undefined;
    const result: WorkerResult = {
      id: inFlight.callId ?? `${inFlight.taskId}:interrupted`,
      provider: (agent && this.#settings.providers[agent.provider]?.kind) ?? "unknown",
      status: "failed",
      startedAt: at,
      finishedAt: at,
      durationMs: 0,
      exitCode: null,
      finalOutput: "",
      usage: {},
      rawEventCount: 0,
      error: "Worker call was interrupted by a runtime restart and was not executed again",
    };
    await this.#store.saveWorkerCall({
      id: result.id,
      runId: drive.run.id,
      taskId: inFlight.taskId,
      createdAt: at,
      result,
    });
    await this.#finishWork(drive, result);
  }

  async #finishWork(drive: Drive, result: WorkerResult): Promise<void> {
    const { taskId, role = "implementation", agentName = "unknown" } = drive.cp;
    if (!taskId) throw new Error("Work checkpoint has no task");
    const runId = drive.run.id;
    const budget = drive.run.budget;
    budget.inputTokens += result.usage.inputTokens ?? 0;
    budget.outputTokens += result.usage.outputTokens ?? 0;
    budget.estimatedCostUsd += result.usage.estimatedCostUsd ?? 0;
    await this.#appendOnce({
      id: `${result.id}:result`,
      runId,
      type: role === "review" ? "review" : "agent-result",
      source: agentName,
      createdAt: result.finishedAt,
      metadata: { taskId, callId: result.id, status: result.status },
      content: {
        status: result.status,
        ...(result.report ? { report: result.report } : {}),
        ...(result.error ? { error: result.error } : {}),
        finalOutput: result.finalOutput.slice(-4_000),
      },
    });
    const task = await this.#store.getTask(taskId);
    if (task) {
      const status = result.status === "succeeded" ? "completed" : "failed";
      await this.#store.saveTask({ ...task, status, updatedAt: iso(this.#now()) });
    }
    drive.cp = { ...withoutInFlight(drive.cp), phase: "verify" };
    await this.#commit(drive, [{ type: "worker.completed", runId, taskId, result }]);
  }

  async #verify(drive: Drive): Promise<void> {
    const { baseline, taskId, role = "implementation", agentName } = drive.cp;
    if (!baseline || !taskId) throw new Error("Verify checkpoint has no baseline");
    if (drive.run.status !== "verifying") await this.#transition(drive, "verifying");
    const verification = await verifyWorkspace(baseline, this.#settings.verification, {
      signal: drive.abort.signal,
      redactEnvironment: this.#settings.telemetry.redactEnvironment,
    });
    // An interrupted verification is not evidence; it runs again when the run resumes.
    if (drive.stop) return;
    const observed = await captureGitState(drive.run.workspace);
    const workerChanges = verification.gitEvidence.changesSinceBaseline;
    const changed = workerChanges.length > 0 || verification.gitEvidence.headChanged;
    const runId = drive.run.id;
    const at = iso(this.#now());
    await this.#appendOnce({
      id: `${taskId}:verification`,
      runId,
      type: "test-result",
      source: "verification",
      createdAt: at,
      metadata: { taskId, ok: verification.result.ok },
      content: verification.result.commands.map((command) => ({
        name: command.name,
        exitCode: command.exitCode,
        timedOut: command.timedOut,
        stdout: command.stdout,
        stderr: command.stderr,
      })),
    });
    await this.#appendOnce({
      id: `${taskId}:diff`,
      runId,
      type: "diff",
      source: "workspace",
      createdAt: at,
      metadata: { taskId },
      content: { diffStat: verification.result.gitDiffStat, workerChanges },
    });
    const events: HarnessEvent[] = [{ type: "verification.completed", runId, result: verification.result }];
    drive.cp = { ...drive.cp, verification: verification.result, observed };
    const agent = agentName ? this.#settings.agents[agentName] : undefined;
    if ((role === "review" || agent?.readOnly) && changed) {
      const paths = workerChanges.map((change) => change.path).slice(0, 20);
      return this.#fail(drive, `Read-only worker changed the workspace: ${paths.join(", ") || "HEAD moved"}`, events);
    }
    drive.cp =
      role === "review"
        ? { ...drive.cp, phase: "complete", reviewCompletedForAttempt: true, editsSinceReview: false }
        : { ...drive.cp, phase: "complete", editsSinceReview: drive.cp.editsSinceReview || changed };
    await this.#commit(drive, events);
  }

  async #complete(drive: Drive): Promise<void> {
    const verification = drive.cp.verification;
    if (!verification) throw new Error("Completion checkpoint has no verification");
    const limits = this.#settings.limits;
    drive.run.currentStep++;
    await this.#appendOnce({
      id: `${drive.run.id}:limits:${drive.run.currentStep}`,
      runId: drive.run.id,
      type: "observation",
      source: "run-limits",
      createdAt: iso(this.#now()),
      metadata: {},
      content: {
        step: drive.run.currentStep,
        maxSteps: limits.maxSteps,
        retries: drive.cp.retries,
        maxRetriesPerTask: limits.maxRetriesPerTask,
        budget: drive.run.budget,
      },
    });
    let action: NextAction;
    let reasons: string[];
    try {
      const decision = normalizeCompletionDecision(await this.#decide(drive, "completion", completionRequest));
      action = selectNextAction(
        decision,
        verification,
        drive.run,
        { routing: this.#settings.routing, limits },
        { reviewCompletedForAttempt: drive.cp.reviewCompletedForAttempt, editsSinceReview: drive.cp.editsSinceReview },
      );
      reasons = [...decision.reasonCodes];
    } catch (error) {
      if (!(error instanceof DecisionHandoffError)) throw error;
      action = error.action;
      reasons = ["decision-handoff", error.reason];
    }
    await this.#applyAction(drive, action, reasons);
  }

  async #applyAction(drive: Drive, requested: NextAction, reasonCodes: string[]): Promise<void> {
    const limits = this.#settings.limits;
    const reasons = [...reasonCodes];
    let action = requested;
    if (action === "verify" || action === "research") {
      reasons.push(`${action}-unsupported`);
      action = "ask-user";
    }
    if (action === "retry" && drive.cp.retries >= limits.maxRetriesPerTask) {
      reasons.push("retry-limit");
      action = "fail";
    }
    const exhausted = exhaustedBudget(drive.run, limits);
    if (exhausted && (action === "retry" || action === "review" || action === "fail")) {
      if (!reasons.includes(exhausted)) reasons.push(exhausted);
      action = "fail";
    }
    const events: HarnessEvent[] = [{ type: "policy.action", runId: drive.run.id, action, reasonCodes: reasons }];
    switch (action) {
      case "done":
        return this.#transition(drive, "completed", () => [
          ...events,
          { type: "run.completed", run: structuredClone(drive.run) },
        ]);
      case "retry":
        drive.cp = {
          ...drive.cp,
          attempt: drive.cp.attempt + 1,
          retries: drive.cp.retries + 1,
          reviewCompletedForAttempt: false,
          editsSinceReview: false,
        };
        return this.#assign(
          drive,
          "implementation",
          drive.cp.implementationAgent ?? this.#settings.routing.defaultAgent,
          drive.cp.taskKind ?? "implementation",
          events,
        );
      case "review":
        return this.#assign(drive, "review", this.#settings.routing.reviewerAgent, "review", events);
      case "ask-user": {
        const choices = COMPLETION_CHOICES.filter(
          (choice) => choice !== "retry" || drive.cp.retries < limits.maxRetriesPerTask,
        );
        return this.#requestApproval(
          drive,
          { resume: "completion" },
          "risk-acceptance",
          {
            prompt: `The run needs a decision${reasons.length ? ` (${reasons.join(", ")})` : ""}. Choose the next action.`,
            choices: [...choices],
          },
          events,
        );
      }
      default:
        return this.#fail(drive, reasons.join(", ") || "policy-fail", events);
    }
  }

  async #afterApproval(drive: Drive): Promise<void> {
    const { approval, ...rest } = drive.cp;
    if (!approval?.answer) throw new Error("Answered checkpoint has no answer");
    drive.cp = rest;
    const answer = approval.answer;
    switch (approval.resume) {
      case "route-clarification":
        return this.#assign(
          drive,
          "implementation",
          approval.agentName ?? this.#settings.routing.defaultAgent,
          drive.cp.taskKind ?? "implementation",
        );
      case "route-handoff":
        if (answer === "fail") return this.#fail(drive, "route-handoff: person chose to fail the run");
        return this.#assign(drive, "implementation", answer, drive.cp.taskKind ?? "implementation");
      case "completion":
        return this.#applyAction(drive, answer as NextAction, ["person-selected"]);
    }
  }

  async #requestApproval(
    drive: Drive,
    resume: Omit<NonNullable<RunCheckpoint["approval"]>, "id">,
    kind: ApprovalRequest["kind"],
    request: { prompt: string; choices?: string[] },
    events: HarnessEvent[] = [],
  ): Promise<void> {
    const runId = drive.run.id;
    const approval: ApprovalRequest = {
      id: `${runId}:approval:${randomUUID()}`,
      runId,
      ...(drive.cp.taskId ? { taskId: drive.cp.taskId } : {}),
      kind,
      prompt: request.prompt,
      ...(request.choices ? { choices: request.choices } : {}),
      status: "pending",
      createdAt: iso(this.#now()),
    };
    drive.cp = { ...drive.cp, phase: "await-approval", approval: { ...resume, id: approval.id } };
    await this.#transition(
      drive,
      "paused",
      [
        ...events,
        { type: "approval.requested", request: approval },
        { type: "run.paused", runId, reason: "awaiting approval" },
      ],
      { approval, clearControls: ["pause"] },
    );
  }

  async #fail(drive: Drive, reason: string, events: HarnessEvent[] = []): Promise<void> {
    if (isTerminalStatus(drive.run.status)) return;
    const error = reason.slice(0, 2_000);
    drive.run.failureReason = error;
    const task = drive.cp.taskId ? await this.#store.getTask(drive.cp.taskId) : undefined;
    if (task && (task.status === "pending" || task.status === "running")) {
      await this.#store.saveTask({ ...task, status: "failed", updatedAt: iso(this.#now()) });
    }
    await this.#transition(
      drive,
      "failed",
      () => [...events, { type: "run.failed", run: structuredClone(drive.run), error }],
      { clearControls: ["pause"] },
    );
  }

  async #cancel(drive: Drive): Promise<void> {
    for (const approval of await this.#store.listApprovals(drive.run.id, "pending")) {
      await this.#commit(drive, [], { approval: { ...approval, status: "cancelled" } });
    }
    await this.#transition(
      drive,
      "cancelled",
      [{ type: "run.cancelled", runId: drive.run.id, reason: drive.stop?.reason ?? "cancel requested" }],
      { clearControls: ["cancel", "pause"] },
    );
  }

  async #transition(
    drive: Drive,
    to: RunStatus,
    events: HarnessEvent[] | (() => HarnessEvent[]) = [],
    extra: Pick<RunCommit, "approval" | "clearControls"> = {},
  ): Promise<void> {
    const from = drive.run.status;
    const change: HarnessEvent[] = [];
    if (from !== to) {
      assertTransition(from, to);
      drive.run.status = to;
      if (isTerminalStatus(to)) drive.run.completedAt = iso(this.#now());
      change.push({ type: "run.status-changed", runId: drive.run.id, from, to });
    }
    await this.#commit(drive, () => [...change, ...(typeof events === "function" ? events() : events)], extra);
  }

  /** Serializes every commit for a drive and charges active time to the run budget. */
  #commit(
    drive: Drive,
    events: HarnessEvent[] | (() => HarnessEvent[]),
    extra: Pick<RunCommit, "approval" | "clearControls"> = {},
  ): Promise<void> {
    const result = drive.queue.then(async () => {
      const at = this.#now();
      if (drive.timed) drive.run.budget.elapsedMs += Math.max(0, at - drive.tick);
      drive.tick = at;
      drive.run.updatedAt = iso(at);
      const runId = drive.run.id;
      let sequence = await this.#store.lastEventSequence(runId);
      const envelopes = (typeof events === "function" ? events() : events).map((payload): EventEnvelope => ({
        id: randomUUID(),
        version: 1,
        sequence: ++sequence,
        runId,
        occurredAt: iso(at),
        correlationId: runId,
        payload,
      }));
      try {
        await this.#store.commitRun(runId, this.#owner, {
          run: drive.run,
          checkpoint: drive.cp,
          events: envelopes,
          ...extra,
        });
      } catch (error) {
        if (/lease is not held/.test(errorMessage(error))) throw new LeaseLostError();
        throw error;
      }
    });
    drive.queue = result.catch(() => undefined);
    return result;
  }

  /** Chunk writes happen before the commit that references them, so a replayed phase may find them present. */
  async #appendOnce(chunk: StateChunk): Promise<void> {
    if (!(await this.#store.get(chunk.id))) await this.#store.append(chunk);
  }
}

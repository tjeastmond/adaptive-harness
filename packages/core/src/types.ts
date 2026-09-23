export type RunId = string;
export type TaskId = string;
export type WorkerCallId = string;
export type DecisionId = string;
export type StateChunkId = string;
export type CapabilityId = string;

export type TaskKind = "implementation" | "debugging" | "architecture" | "research" | "review";

export type RunStatus =
  "created" | "routing" | "running" | "verifying" | "reviewing" | "paused" | "completed" | "failed" | "cancelled";

export type NextAction = "done" | "retry" | "verify" | "review" | "research" | "ask-user" | "fail";

export type AgentPurpose = "implementation" | "research" | "review";

export interface Objective {
  text: string;
  acceptanceCriteria: string[];
  suppliedContext?: string;
}

/**
 * Canonical, addressable state. A conversation transcript is one possible
 * source of chunks, never the sole representation of a run.
 */
export type StateChunkType =
  | "user-message"
  | "agent-result"
  | "file"
  | "file-fragment"
  | "diff"
  | "tool-input"
  | "tool-output"
  | "instruction"
  | "plan"
  | "observation"
  | "review"
  | "test-result";

export interface StateChunk {
  id: StateChunkId;
  runId: RunId;
  type: StateChunkType;
  source: string;
  createdAt: string;
  metadata: Record<string, unknown>;
  content: unknown;
}

export type ContextVisibility = "hidden" | "short" | "long" | "full";

export interface ContextAssemblyRequest {
  runId: RunId;
  purpose: "worker" | "decision" | "review" | "verification";
  objective: Objective;
  candidateChunkIds?: StateChunkId[];
}

export interface ContextAssembly {
  chunks: Array<{ chunk: StateChunk; visibility: ContextVisibility }>;
  summary: string;
  /** SHA-256 of the exact summary sent to the next operation. */
  renderedContentHash: string;
}

export interface StateStore {
  append(chunk: StateChunk): Promise<void>;
  get(id: StateChunkId): Promise<StateChunk | undefined>;
  list(runId: RunId, options?: { types?: StateChunkType[]; limit?: number }): Promise<StateChunk[]>;
}

export interface ContextAssembler {
  assemble(request: ContextAssemblyRequest): Promise<ContextAssembly>;
}

export type TaskAccessMode = "read" | "write";

export interface TaskAccess {
  mode: TaskAccessMode;
  resources?: string[];
}

/** A reference to a pre-existing capability; the harness does not reimplement it. */
export type CapabilityKind = "cli" | "mcp" | "skill" | "provider";

export interface CapabilityDefinition {
  id: CapabilityId;
  kind: CapabilityKind;
  description: string;
  enabled: boolean;
  permission: "allow" | "ask" | "deny";
  command?: string;
  reference?: string;
}

export interface HarnessTask {
  id: TaskId;
  runId: RunId;
  parentTaskId?: TaskId;
  kind: TaskKind;
  objective: Objective;
  attempt: number;
  assignedAgent?: string;
  access: TaskAccess;
  status: "pending" | "running" | "completed" | "failed" | "paused";
  createdAt: string;
  updatedAt: string;
}

export interface Usage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "unknown";
  additions?: number;
  deletions?: number;
}

export interface WorkerRequest {
  runId: RunId;
  task: HarnessTask;
  agentName: string;
  instructions: string;
  workspace: string;
  model?: string;
  readOnly: boolean;
  timeoutMs: number;
  environment: Record<string, string>;
}

export interface WorkerReport {
  summary: string;
  completed: boolean;
  filesChanged: FileChange[];
  checksRun: string[];
  concerns: string[];
  requestedHelp?: string;
}

export interface WorkerResult {
  id: WorkerCallId;
  provider: string;
  status: "succeeded" | "failed" | "timed-out" | "cancelled";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  sessionId?: string;
  report?: WorkerReport;
  finalOutput: string;
  usage: Usage;
  rawEventCount: number;
  error?: string;
}

export interface WorkerAdapter {
  readonly kind: "codex-cli" | "cursor-cli";

  preflight(): Promise<ProviderPreflight>;

  execute(request: WorkerRequest, emit: (event: WorkerStreamEvent) => void | Promise<void>): Promise<WorkerResult>;

  cancel(callId: WorkerCallId): Promise<void>;
}

export interface ProviderPreflight {
  ok: boolean;
  version?: string;
  authenticated?: boolean;
  details: string[];
}

export type WorkerStreamEvent =
  | { type: "session.started"; sessionId?: string; at: string }
  | { type: "message"; role: "assistant" | "system"; text: string; at: string }
  | { type: "tool.started"; name: string; callId?: string; at: string }
  | { type: "tool.completed"; name: string; callId?: string; ok: boolean; at: string }
  | { type: "usage"; usage: Usage; at: string }
  | { type: "provider.raw"; value: unknown; at: string };

export type DecisionQuestion =
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string>;
    }
  | {
      type: "score";
      instructions: string;
      criteria: string[];
    }
  | {
      type: "noul";
      instructions: string;
    };

export type DecisionAnswer =
  | {
      type: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | {
      type: "score";
      score: number;
      confidence: number;
      probabilities: Record<string, number>;
      legend?: Record<string, string>;
    }
  | {
      type: "noul";
      noul: number;
    };

export interface DecisionRequest {
  state: string;
  questions: Record<string, DecisionQuestion>;
}

export interface DecisionResponse {
  id: DecisionId;
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: Usage;
  durationMs: number;
  raw: unknown;
}

export interface DecisionProvider {
  readonly kind: "jev" | "deterministic";
  preflight(): Promise<ProviderPreflight>;
  evaluate(request: DecisionRequest): Promise<DecisionResponse>;
}

export interface RouteDecision {
  taskKind: TaskKind;
  taskKindConfidence: number;
  complexityScore: number;
  complexityConfidence: number;
  needsExternalResearch: number;
  requirementsClear: number;
  selectedAgent: string;
  reasonCodes: string[];
}

export interface CompletionDecision {
  requirementsSatisfied: number;
  implementationRiskScore: number;
  implementationRiskConfidence: number;
  moreWorkUseful: number;
  needsIndependentReview: number;
  nextAction: NextAction;
  nextActionConfidence: number;
  reasonCodes: string[];
}

export interface VerificationCommandResult {
  name: string;
  command: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface VerificationResult {
  ok: boolean;
  commands: VerificationCommandResult[];
  gitDiffStat: string;
  filesChanged: FileChange[];
}

export interface RunBudget {
  workerCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  elapsedMs: number;
}

export interface HarnessRun {
  id: RunId;
  status: RunStatus;
  objective: Objective;
  workspace: string;
  configPath: string;
  configHash: string;
  currentTaskId?: TaskId;
  currentStep: number;
  budget: RunBudget;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failureReason?: string;
}

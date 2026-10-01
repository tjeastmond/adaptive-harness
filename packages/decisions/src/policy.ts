import type {
  CompletionDecision,
  DecisionAnswer,
  DecisionResponse,
  HarnessRun,
  NextAction,
  RouteDecision,
  TaskKind,
  VerificationResult,
} from "@adaptive-harness/core";

export interface RoutingPolicy {
  defaultAgent: string;
  complexAgent: string;
  complexTaskScore: number;
  requireReviewRiskScore: number;
  autoProceedConfidence: number;
  askUserBelowConfidence: number;
}

export interface DecisionPolicyConfig {
  routing: RoutingPolicy;
  limits: BudgetLimits;
}

export interface BudgetLimits {
  maxSteps: number;
  maxWorkerCalls: number;
  maxInputTokens: number;
  maxCostUsd: number;
  maxElapsedMs: number;
}

export interface PolicyProgress {
  reviewCompletedForAttempt: boolean;
  editsSinceReview: boolean;
  /** The role of the latest worker call, when that call failed. */
  failedCall?: "implementation" | "review";
  /** Whether the task's retry limit allows another implementation attempt. Defaults to true. */
  retryAvailable?: boolean;
}

const TASK_KINDS = new Set<TaskKind>(["implementation", "debugging", "architecture", "research", "review"]);
const NEXT_ACTIONS = new Set<NextAction>(["done", "retry", "verify", "review", "research", "ask-user", "fail"]);

function answer(response: DecisionResponse, name: string, type: DecisionAnswer["type"]): DecisionAnswer {
  const value = response.answers[name];
  if (!value || value.type !== type) throw new Error(`Decision answer ${name} must be ${type}`);
  return value;
}

function choice(response: DecisionResponse, name: string): { value: string; confidence: number } {
  const value = answer(response, name, "choice");
  if (value.type !== "choice") throw new Error(`Decision answer ${name} must be choice`);
  return { value: value.choice, confidence: value.confidence };
}

function score(response: DecisionResponse, name: string): { value: number; confidence: number } {
  const value = answer(response, name, "score");
  if (value.type !== "score" || value.score < 0 || value.score > 4) {
    throw new Error(`Decision answer ${name} must be a score from 0 to 4`);
  }
  return { value: value.score, confidence: value.confidence };
}

function noul(response: DecisionResponse, name: string): number {
  const value = answer(response, name, "noul");
  if (value.type !== "noul") throw new Error(`Decision answer ${name} must be noul`);
  return value.noul;
}

export function normalizeRouteDecision(response: DecisionResponse, routing: RoutingPolicy): RouteDecision {
  const taskKind = choice(response, "task_kind");
  if (!TASK_KINDS.has(taskKind.value as TaskKind)) throw new Error("Unsupported task kind from Jev");
  const complexity = score(response, "complexity");
  const requirementsClear = noul(response, "requirements_clear");
  const needsExternalResearch = noul(response, "external_research_needed");
  const selectedAgent =
    taskKind.value === "architecture" || complexity.value >= routing.complexTaskScore
      ? routing.complexAgent
      : routing.defaultAgent;
  return {
    taskKind: taskKind.value as TaskKind,
    taskKindConfidence: taskKind.confidence,
    complexityScore: complexity.value,
    complexityConfidence: complexity.confidence,
    requirementsClear,
    needsExternalResearch,
    selectedAgent,
    reasonCodes: [
      ...(requirementsClear < routing.askUserBelowConfidence ? ["requirements-unclear"] : []),
      ...(selectedAgent === routing.complexAgent ? ["complex-route"] : []),
      ...(needsExternalResearch >= routing.autoProceedConfidence ? ["external-research-needed"] : []),
    ],
  };
}

export function normalizeCompletionDecision(response: DecisionResponse): CompletionDecision {
  const risk = score(response, "implementation_risk");
  const next = choice(response, "next_action");
  if (!NEXT_ACTIONS.has(next.value as NextAction)) throw new Error("Unsupported next action from Jev");
  return {
    requirementsSatisfied: noul(response, "requirements_satisfied"),
    implementationRiskScore: risk.value,
    implementationRiskConfidence: risk.confidence,
    moreWorkUseful: noul(response, "more_work_useful"),
    needsIndependentReview: noul(response, "independent_review_needed"),
    nextAction: next.value as NextAction,
    nextActionConfidence: next.confidence,
    reasonCodes: [],
  };
}

export function selectInitialAgent(route: RouteDecision, config: { routing: RoutingPolicy }): string | NextAction {
  if (route.requirementsClear < config.routing.askUserBelowConfidence) return "ask-user";
  if (route.taskKind === "architecture" || route.complexityScore >= config.routing.complexTaskScore) {
    return config.routing.complexAgent;
  }
  return config.routing.defaultAgent;
}

/** Input tokens the token limit counts: cached input is a subset of input, so only the uncached remainder is bounded. */
export function uncachedInputTokens(usage: { inputTokens?: number; cachedInputTokens?: number }): number {
  return Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0));
}

/** Returns the first exhausted budget, if any. An exhausted budget forbids starting more work. */
export function exhaustedBudget(run: Pick<HarnessRun, "currentStep" | "budget">, limits: BudgetLimits) {
  if (run.currentStep >= limits.maxSteps) return "step-limit";
  if (run.budget.workerCalls >= limits.maxWorkerCalls) return "worker-call-limit";
  if (uncachedInputTokens(run.budget) >= limits.maxInputTokens) return "token-limit";
  if (run.budget.estimatedCostUsd >= limits.maxCostUsd) return "cost-limit";
  if (run.budget.elapsedMs >= limits.maxElapsedMs) return "time-limit";
  return undefined;
}

export function selectNextAction(
  decision: CompletionDecision,
  verification: VerificationResult,
  run: HarnessRun,
  config: DecisionPolicyConfig,
  progress: PolicyProgress,
): NextAction {
  const action = selectUnboundedAction(decision, verification, config, progress);
  if (action === "done" && progress.failedCall) {
    // A failed worker call never completes the run: a failed implementation is tried again while retries and
    // budget remain; otherwise a person decides.
    const canRetry =
      progress.failedCall === "implementation" &&
      progress.retryAvailable !== false &&
      !exhaustedBudget(run, config.limits);
    return canRetry ? "retry" : "ask-user";
  }
  // Budgets stop further work; they do not discard a satisfied result or a request for human judgment.
  if (action === "done" || action === "ask-user") return action;
  return exhaustedBudget(run, config.limits) ? "fail" : action;
}

function selectUnboundedAction(
  decision: CompletionDecision,
  verification: VerificationResult,
  config: DecisionPolicyConfig,
  progress: PolicyProgress,
): NextAction {
  if (!verification.ok && decision.moreWorkUseful >= 0.65) return "retry";
  const reviewRequested =
    decision.implementationRiskScore >= config.routing.requireReviewRiskScore ||
    decision.needsIndependentReview >= config.routing.autoProceedConfidence ||
    decision.nextAction === "review";
  const reviewEligible = !progress.reviewCompletedForAttempt || progress.editsSinceReview;
  if (reviewRequested) return reviewEligible ? "review" : "ask-user";
  if (decision.nextActionConfidence < config.routing.askUserBelowConfidence) return "ask-user";
  if (
    decision.requirementsSatisfied >= config.routing.autoProceedConfidence &&
    verification.ok &&
    decision.moreWorkUseful < 0.35
  ) {
    return "done";
  }
  if (!verification.ok && decision.nextAction === "done") return "ask-user";
  return decision.nextAction;
}

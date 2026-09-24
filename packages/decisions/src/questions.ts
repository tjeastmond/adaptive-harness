import type { DecisionRequest } from "@adaptive-harness/core";

export const routeQuestions = {
  task_kind: {
    type: "choice",
    instructions: "Classify the primary kind of work required by the objective",
    criteria: {
      implementation: "A bounded code change with sufficiently clear requirements",
      debugging: "The cause of incorrect behavior must be identified and fixed",
      architecture: "The task requires consequential system design before implementation",
      research: "The task primarily requires gathering information",
      review: "The task primarily requires evaluating an existing change",
    },
  },
  complexity: {
    type: "score",
    instructions: "Score the engineering complexity of completing this objective",
    criteria: [
      "Trivial and localized",
      "Small and well understood",
      "Moderate with several interacting concerns",
      "Complex and cross-cutting",
      "Highly complex or architecturally consequential",
    ],
  },
  requirements_clear: {
    type: "noul",
    instructions: "The objective is clear enough for an agent to begin safely",
  },
  external_research_needed: {
    type: "noul",
    instructions: "Completing the objective requires information not likely present in the repository",
  },
} as const satisfies DecisionRequest["questions"];

export const completionQuestions = {
  requirements_satisfied: {
    type: "noul",
    instructions: "The current repository changes satisfy the stated objective and acceptance criteria",
  },
  implementation_risk: {
    type: "score",
    instructions: "Score the risk of merging the current changes",
    criteria: ["Trivial risk", "Low risk", "Moderate risk", "High risk", "Critical risk"],
  },
  more_work_useful: {
    type: "noul",
    instructions: "Another implementation attempt is likely to materially improve the result",
  },
  independent_review_needed: {
    type: "noul",
    instructions: "The current change warrants an independent agent review before completion",
  },
  next_action: {
    type: "choice",
    instructions: "Choose the most appropriate immediate next action",
    criteria: {
      done: "The objective is satisfied and evidence is adequate",
      retry: "Implementation needs another attempt",
      verify: "More deterministic verification is needed",
      review: "An independent review is needed",
      research: "Missing information blocks reliable completion",
      "ask-user": "A human decision or clarification is required",
      fail: "The run cannot make useful progress within its constraints",
    },
  },
} as const satisfies DecisionRequest["questions"];

export function routeRequest(state: string): DecisionRequest {
  return { state, questions: routeQuestions };
}

export function completionRequest(state: string): DecisionRequest {
  return { state, questions: completionQuestions };
}

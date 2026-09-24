import { randomUUID } from "node:crypto";
import type { DecisionAnswer, DecisionProvider, DecisionRequest, DecisionResponse } from "@adaptive-harness/core";

/** Conservative explicit bypass. It requests human judgment when evidence is uncertain. */
export class DeterministicDecisionProvider implements DecisionProvider {
  readonly kind = "deterministic" as const;

  async preflight() {
    return { ok: true, details: ["Deterministic decision bypass available"] };
  }

  async evaluate(request: DecisionRequest): Promise<DecisionResponse> {
    const started = performance.now();
    const answers: Record<string, DecisionAnswer> = {};
    for (const [name, question] of Object.entries(request.questions)) {
      if (question.type === "noul") {
        answers[name] = { type: "noul", noul: name === "independent_review_needed" ? 1 : 0 };
      } else if (question.type === "score") {
        const score = question.criteria.length - 1;
        answers[name] = {
          type: "score",
          score,
          confidence: 1,
          probabilities: Object.fromEntries(
            question.criteria.map((_, index) => [String(index), index === score ? 1 : 0]),
          ),
        };
      } else {
        const choice = name === "next_action" ? "ask-user" : Object.keys(question.criteria)[0];
        if (!choice || !Object.hasOwn(question.criteria, choice)) {
          throw new Error(`Cannot bypass unsupported choice question ${name}`);
        }
        answers[name] = {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0])),
        };
      }
    }
    return {
      id: randomUUID(),
      model: "deterministic-bypass",
      answers,
      usage: {},
      durationMs: Math.max(0, performance.now() - started),
      raw: { reason: "conservative deterministic decision" },
    };
  }
}

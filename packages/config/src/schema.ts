import { z } from "zod";

export const ProviderSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("codex-cli"),
      command: z.string().min(1).default("codex"),
      model: z.string().min(1).nullable().default(null),
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
      extraArgs: z.array(z.string()).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cursor-cli"),
      command: z.string().min(1).default("cursor-agent"),
      model: z.string().min(1).nullable().default(null),
      outputFormat: z.enum(["json", "stream-json", "text"]).default("stream-json"),
      extraArgs: z.array(z.string()).default([]),
    })
    .strict(),
]);

const VerificationCommandSchema = z
  .object({
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().default(300_000),
    env: z.record(z.string(), z.string()).default({}),
  })
  .strict();

const EnvironmentNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

export const HarnessConfigSchema = z
  .object({
    version: z.literal(1),
    project: z
      .object({
        name: z.string().min(1),
        workspace: z.string().min(1).default("."),
      })
      .strict(),
    storage: z
      .object({
        database: z.string().min(1).default(".harness/harness.sqlite"),
      })
      .strict(),
    decision: z
      .object({
        mode: z.enum(["jev", "deterministic"]).default("jev"),
        allowBypass: z.boolean().default(true),
        bypassEnv: EnvironmentNameSchema.default("HARNESS_DECISION_MODE"),
        jev: z
          .object({
            model: z.string().min(1).default("jev-latest"),
            baseUrl: z.url().default("https://api.typesafe.ai/v1/systemone"),
            apiKeyEnv: EnvironmentNameSchema.default("TYPESAFE_API_KEY"),
            timeoutMs: z.number().int().positive().default(15_000),
            transientRetries: z.number().int().min(0).max(5).default(2),
          })
          .strict(),
        fallback: z
          .object({
            onUnavailable: z.enum(["deterministic", "ask-user", "fail"]),
            onLowConfidence: z.enum(["deterministic", "ask-user", "fail"]),
          })
          .strict(),
      })
      .strict(),
    providers: z.record(z.string(), ProviderSchema),
    agents: z.record(
      z.string(),
      z
        .object({
          provider: z.string().min(1),
          purpose: z.enum(["implementation", "research", "review"]),
          instructions: z.string().min(1),
          readOnly: z.boolean().default(false),
        })
        .strict(),
    ),
    routing: z
      .object({
        defaultAgent: z.string().min(1),
        complexAgent: z.string().min(1),
        reviewerAgent: z.string().min(1),
        complexTaskScore: z.number().min(0).max(4).default(3),
        requireReviewRiskScore: z.number().min(0).max(4).default(3),
        autoProceedConfidence: z.number().min(0).max(1).default(0.85),
        verifyConfidence: z.number().min(0).max(1).default(0.65),
        askUserBelowConfidence: z.number().min(0).max(1).default(0.5),
      })
      .strict(),
    limits: z
      .object({
        maxSteps: z.number().int().positive().default(8),
        maxRetriesPerTask: z.number().int().nonnegative().default(2),
        maxWorkerCalls: z.number().int().positive().default(5),
        maxInputTokens: z.number().int().positive().default(1_000_000),
        maxCostUsd: z.number().positive().default(10),
        workerTimeoutMs: z.number().int().positive().default(1_200_000),
      })
      .strict(),
    git: z
      .object({
        requireRepository: z.boolean().default(true),
        requireClean: z.boolean().default(true),
        allowUntracked: z.boolean().default(false),
      })
      .strict(),
    verification: z
      .object({
        stopOnFailure: z.boolean().default(false),
        commands: z.array(VerificationCommandSchema).default([]),
      })
      .strict(),
    telemetry: z
      .object({
        console: z.enum(["pretty", "json", "silent"]).default("pretty"),
        retainRawProviderEvents: z.boolean().default(true),
        redactEnvironment: z.array(EnvironmentNameSchema).default([]),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    for (const [name, agent] of Object.entries(config.agents)) {
      if (!Object.hasOwn(config.providers, agent.provider)) {
        context.addIssue({ code: "custom", path: ["agents", name, "provider"], message: "Unknown provider reference" });
      }
    }
    for (const field of ["defaultAgent", "complexAgent", "reviewerAgent"] as const) {
      if (!Object.hasOwn(config.agents, config.routing[field])) {
        context.addIssue({ code: "custom", path: ["routing", field], message: "Unknown agent reference" });
      }
    }
  });

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderSchema>;

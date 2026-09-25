import { type HarnessConfig, loadHarnessConfig } from "@adaptive-harness/config";
import type { DecisionProvider, ProviderPreflight, RunId, WorkerAdapter } from "@adaptive-harness/core";
import { type DecisionMode, JevHttpProvider } from "@adaptive-harness/decisions";
import { SqliteHarnessStore } from "@adaptive-harness/persistence";
import type { HarnessRuntime } from "@adaptive-harness/protocol";
import { createConfiguredWorkers, LocalHarnessRuntime } from "@adaptive-harness/runtime";

export interface OpenRuntimeRequest {
  configPath?: string;
  /** `--decision-mode`; otherwise the config's bypass variable, then `decision.mode`. */
  decisionMode?: DecisionMode;
  /** Commands that make decisions need the Jev API key unless the decision mode is deterministic. */
  requireDecisions: boolean;
  env: Record<string, string | undefined>;
}

export interface ProviderCheck extends ProviderPreflight {
  name: string;
  kind: string;
}

/** The runtime and its resources for one CLI invocation. */
export interface CliRuntime {
  runtime: HarnessRuntime;
  config: HarnessConfig;
  configPath: string;
  decisionMode: DecisionMode;
  /** Pauses runs whose previous owner stopped renewing its lease. */
  recoverInterruptedRuns(): Promise<RunId[]>;
  preflight(): Promise<ProviderCheck[]>;
  close(): void;
}

export type OpenRuntime = (request: OpenRuntimeRequest) => Promise<CliRuntime>;

/** Providers that replace the configured Jev client or worker adapters, for tests and embedding. */
export interface RuntimeOverrides {
  jev?: DecisionProvider;
  workers?: Record<string, WorkerAdapter>;
  pollIntervalMs?: number;
}

function decisionMode(
  config: HarnessConfig,
  request: OpenRuntimeRequest,
): { mode: DecisionMode; reason?: string } | { error: string } {
  if (request.decisionMode) {
    return request.decisionMode === "deterministic"
      ? { mode: "deterministic", reason: "cli --decision-mode" }
      : { mode: "jev" };
  }
  const name = config.decision.bypassEnv;
  const value = request.env[name];
  if (value === undefined || value === "") return { mode: config.decision.mode };
  if (value === "deterministic") return { mode: "deterministic", reason: `environment ${name}` };
  if (value === "jev") return { mode: "jev" };
  return { error: `${name} must be jev or deterministic` };
}

export async function openLocalRuntime(request: OpenRuntimeRequest, overrides: RuntimeOverrides = {}) {
  const loaded = await loadHarnessConfig({
    ...(request.configPath === undefined ? {} : { configPath: request.configPath }),
    env: request.env,
    requireSecrets: false,
  });
  const { config } = loaded;
  const selected = decisionMode(config, request);
  if ("error" in selected) throw new Error(selected.error);
  if (selected.mode === "deterministic" && !config.decision.allowBypass) {
    throw new Error("Deterministic decision bypass is disabled by decision.allowBypass");
  }
  const apiKeyEnv = config.decision.jev.apiKeyEnv;
  const apiKey = request.env[apiKeyEnv] ?? "";
  if (request.requireDecisions && selected.mode === "jev" && !apiKey && !overrides.jev) {
    throw new Error(`Missing secret environment variable ${apiKeyEnv}; set it or use --decision-mode deterministic`);
  }
  const secrets = Object.fromEntries(
    [...new Set([apiKeyEnv, ...config.telemetry.redactEnvironment])].flatMap((name) => {
      const value = request.env[name];
      return value ? [[name, value]] : [];
    }),
  );
  const jev =
    overrides.jev ??
    new JevHttpProvider({
      endpoint: config.decision.jev.baseUrl,
      apiKey,
      model: config.decision.jev.model,
      timeoutMs: config.decision.jev.timeoutMs,
      maxRetries: config.decision.jev.transientRetries,
    });
  const workers = overrides.workers ?? createConfiguredWorkers(config);
  const store = new SqliteHarnessStore(config.storage.database, { redactValues: Object.values(secrets) });
  const runtime = new LocalHarnessRuntime({
    config: loaded,
    store,
    jev,
    workers,
    decisionMode: selected.mode,
    ...(selected.reason ? { decisionReason: selected.reason } : {}),
    // Adapters redact these values from provider output before it reaches events or reports.
    environment: secrets,
    ...(overrides.pollIntervalMs ? { pollIntervalMs: overrides.pollIntervalMs } : {}),
  });
  return {
    runtime,
    config,
    configPath: loaded.path,
    decisionMode: selected.mode,
    recoverInterruptedRuns: () => runtime.recoverInterruptedRuns(),
    async preflight() {
      const checks: ProviderCheck[] = [{ name: "jev", kind: "jev", ...(await jev.preflight()) }];
      for (const [name, provider] of Object.entries(config.providers)) {
        const adapter = workers[name];
        checks.push(
          adapter
            ? { name, kind: provider.kind, ...(await adapter.preflight()) }
            : { name, kind: provider.kind, ok: false, details: ["No adapter is available for this provider"] },
        );
      }
      return checks;
    },
    close: () => store.close(),
  } satisfies CliRuntime;
}

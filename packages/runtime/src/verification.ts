import type { HarnessConfig } from "@adaptive-harness/config";
import type { VerificationResult } from "@adaptive-harness/core";
import { runVerificationCommands, type VerificationOptions } from "@adaptive-harness/verification";
import { captureGitState, compareGitStates, type GitEvidence, type GitState } from "@adaptive-harness/workspace";

export interface WorkspaceVerification {
  result: VerificationResult;
  /** Changes observed after the worker, before verification commands execute. */
  gitEvidence: GitEvidence;
  /** Changes made by verification commands, kept separate from worker changes. */
  verificationGitEvidence: GitEvidence;
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return `[truncated] ${new TextDecoder().decode(bytes.subarray(bytes.byteLength - maxBytes))}`;
}

/** Snapshot immediately after worker execution, before checks that may write files. */
export async function verifyWorkspace(
  before: GitState,
  config: HarnessConfig["verification"],
  options: VerificationOptions = {},
): Promise<WorkspaceVerification> {
  const afterWorker = await captureGitState(before.root);
  const gitEvidence = await compareGitStates(before, afterWorker);
  const commands = await runVerificationCommands(config.commands, before.root, {
    ...options,
    stopOnFailure: config.stopOnFailure,
  });
  const afterVerification = await captureGitState(before.root);
  const verificationGitEvidence = await compareGitStates(afterWorker, afterVerification);
  const finalEvidence = await compareGitStates(before, afterVerification);
  return {
    result: {
      ok: commands.ok,
      commands: commands.commands,
      gitDiffStat: boundedText(finalEvidence.trackedDiffStat, 8_000),
      filesChanged: finalEvidence.changesSinceBaseline,
    },
    gitEvidence,
    verificationGitEvidence,
  };
}

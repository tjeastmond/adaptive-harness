import type { RunStatus } from "./types.ts";

const STOPPABLE = ["paused", "failed", "cancelled"] as const satisfies readonly RunStatus[];

/** Every legal run status change. Terminal statuses have no exits. */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  created: ["routing", ...STOPPABLE],
  routing: ["running", ...STOPPABLE],
  running: ["verifying", ...STOPPABLE],
  reviewing: ["verifying", ...STOPPABLE],
  verifying: ["running", "reviewing", "completed", ...STOPPABLE],
  paused: ["routing", "running", "reviewing", "verifying", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalStatus(status: RunStatus): boolean {
  return RUN_TRANSITIONS[status].length === 0;
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) throw new Error(`Illegal run transition from ${from} to ${to}`);
}

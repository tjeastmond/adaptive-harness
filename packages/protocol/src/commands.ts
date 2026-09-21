/** Versioned command and event protocol (Milestone 1). */
export const PROTOCOL_VERSION = 1 as const;

export type CommandName =
  | "config.validate"
  | "run.start"
  | "runs.list"
  | "runs.show"
  | "runs.watch"
  | "run.pause"
  | "run.resume"
  | "run.cancel"
  | "approvals.answer"
  | "agents.list"
  | "providers.doctor";

export interface CommandEnvelope<TName extends CommandName = CommandName> {
  name: TName;
  version: typeof PROTOCOL_VERSION;
  id: string;
  issuedAt: string;
}

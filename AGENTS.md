# Adaptive Harness agent guide

## Source of truth

- Read `adaptive-agent-harness-foundation.md` before changing runtime contracts or architecture.
- Preserve the package boundaries. The CLI is a client of `HarnessRuntime`; it must not own orchestration, provider execution, persistence, or decision policy.
- Jev makes bounded, typed decisions. TypeScript enforces policy and performs execution. The deterministic decision mode is an explicit, observable bypass.

## Current architectural direction

The original foundation is being revised to adopt the Jev state/context model. Treat these as required design seams before deep implementation work begins:

1. `StateStore` and typed `StateChunk`s are the canonical run state; transcripts are not.
2. `ContextAssembler` builds per-operation context from state chunks.
3. `DecisionGateway` anticipates decisions for routing, context visibility, tools, permissions, delegation, and completion.
4. Tasks declare read/write access semantics and optional resource scope.
5. Capabilities are exposed through a registry, enabling tiered tool disclosure later. Prefer existing CLIs, MCP servers, and installed skills; the harness does not recreate their integrations.
6. Context-compression providers, including Headroom if adopted, remain implementations behind the harness-owned context abstraction.

Cost optimization targets worker usage in Cursor, Codex, and Claude. Jev call cost is negligible for this project; use Jev where its bounded decisions can reduce worker tokens, irrelevant context, or unnecessary worker calls. Evaluate savings against worker spend and task quality, rather than optimizing Jev calls away.

Do not implement advanced dynamic tool loading, broad parallel write execution, or elaborate context compression until these contracts and their focused vertical slice are established.

## Capability boundary

- The harness owns discovery, configuration, context selection, policy, invocation records, and typed results.
- Existing tools own their domain behavior. For example, use the `gh` CLI for GitHub work rather than implementing a GitHub API client.
- A capability may be backed by an installed CLI, an MCP server, an existing skill, or an agent provider. New built-in integrations need a concrete justification.
- Keep the initial registry small and configured: Git, shell, `gh`, configured verification commands, Codex, and Cursor. MCP and skills can be registered when needed.

## Work tracking

**GitHub Issues is the canonical system for tasks, bugs, features, follow-ups, and durable handoffs.** Use the repository's [Issues tab](https://github.com/tjeastmond/adaptive-harness/issues), its issue forms, and `.github/ISSUE_GUIDANCE.md`.

- Use `.agents/ISSUES.md` only for short-lived session scratch notes.
- Open or update one GitHub issue for work that persists beyond the current session or branch.
- Reference the relevant foundation milestone and include paths, verification evidence, and commit SHAs when available.
- Keep one logical item per issue; use issue comments for new evidence on an existing item.

## Git and PR hygiene

- When merging a pull request, delete its source branch. Use `gh pr merge --delete-branch` and verify the remote branch is gone.
- After merging, prune stale remote-tracking refs and delete the local source branch. If it is checked out in a clean linked worktree, detach that worktree at its current commit before deleting the branch; preserve the worktree files.
- Never delete a branch with uncommitted changes or while an active agent still needs that branch.
- Do not attribute work to any AI agent or coding tool. Commits, PR titles and bodies, issue and review comments, and code must not include `Co-Authored-By` trailers, "Generated with" footers, or mentions of Claude, Codex, Cursor, or any other agent or model as an author.

## Implementation expectations

- Keep changes narrowly scoped and add focused tests with the implementation.
- Run the relevant Bun checks before handoff; do not claim verification that was not run.
- Request an independent, read-only Dr. Nit review for every PR before merging, and for substantial changes made directly on `main` before handoff. Scope the review to the PR's changes (or the direct change) rather than the whole repository. Its skill is at `~/.codex/skills/dr-nit/SKILL.md`; agents that do not load Codex skills automatically should read that file and follow its scoped review and reporting instructions. Address findings and rerun relevant checks before merging or handing off.
- Treat provider output and stored raw events as untrusted input, redact secrets, and preserve bounded event/context retention.
- Update the foundation document only when an accepted decision changes a contract.

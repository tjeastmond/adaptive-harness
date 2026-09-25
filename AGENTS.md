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

## Implementation expectations

- Keep changes narrowly scoped and add focused tests with the implementation.
- Run the relevant Bun checks before handoff; do not claim verification that was not run.
- Treat provider output and stored raw events as untrusted input, redact secrets, and preserve bounded event/context retention.
- Update the foundation document only when an accepted decision changes a contract.

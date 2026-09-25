import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGitState } from "@adaptive-harness/workspace";
import { verifyWorkspace } from "../src/verification.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  const process = Bun.spawnSync(["git", "-C", root, ...args]);
  if (process.exitCode !== 0) throw new Error(new TextDecoder().decode(process.stderr));
}

test("verification attributes only changes after the baseline and preserves mixed command results", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-verify-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "existing.txt"), "original");
  git(root, "add", "existing.txt");
  git(root, "commit", "-qm", "initial");
  writeFileSync(join(root, "existing.txt"), "user change");
  const before = await captureGitState(root);
  writeFileSync(join(root, "worker.txt"), "worker change");

  const verification = await verifyWorkspace(before, {
    stopOnFailure: false,
    commands: [
      {
        name: "pass",
        command: "bun",
        args: ["-e", "require('node:fs').writeFileSync('check.txt', 'check output')"],
        timeoutMs: 10_000,
        env: {},
      },
      { name: "fail", command: "bun", args: ["-e", "process.exit(7)"], timeoutMs: 10_000, env: {} },
    ],
  });

  expect(verification.result.ok).toBe(false);
  expect(verification.result.commands.map((command) => command.exitCode)).toEqual([0, 7]);
  expect(verification.gitEvidence.baselineChanges.map((file) => file.path)).toEqual(["existing.txt"]);
  expect(verification.gitEvidence.changesSinceBaseline.map((file) => file.path)).toEqual(["worker.txt"]);
  expect(verification.verificationGitEvidence.changesSinceBaseline.map((file) => file.path)).toEqual(["check.txt"]);
  expect(verification.result.filesChanged.map((file) => file.path).sort()).toEqual(["check.txt", "worker.txt"]);
});

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureGitState, compareGitStates, preflightRepository } from "../src/index.ts";

const dirs: string[] = [];
const defaultPolicy = { requireRepository: true, requireClean: true, allowUntracked: false };

async function command(dir: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exit !== 0) throw new Error(stderr);
}

async function repository(): Promise<string> {
  const dir = await mkdtemp("/private/tmp/harness-workspace-test-");
  dirs.push(dir);
  await command(dir, "init", "-q");
  await command(dir, "config", "user.email", "test@example.com");
  await command(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "tracked.txt"), "initial\n");
  await command(dir, "add", "tracked.txt");
  await command(dir, "commit", "-qm", "initial");
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("repository preflight", () => {
  test("requires a repository when configured", async () => {
    const dir = await mkdtemp("/private/tmp/harness-nonrepo-test-");
    dirs.push(dir);
    expect((await preflightRepository(dir, defaultPolicy)).ok).toBe(false);
    expect((await preflightRepository(dir, { ...defaultPolicy, requireRepository: false })).ok).toBe(true);
  });

  test("optional repository policy does not hide other capture errors", async () => {
    const missing = join("/private/tmp", `harness-missing-${crypto.randomUUID()}`);
    const result = await preflightRepository(missing, { ...defaultPolicy, requireRepository: false });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain("Repository preflight failed");
  });

  test("distinguishes tracked and untracked cleanliness policy", async () => {
    const dir = await repository();
    expect((await preflightRepository(dir, defaultPolicy)).ok).toBe(true);
    await writeFile(join(dir, "new file.txt"), "new\n");
    const untracked = await preflightRepository(dir, defaultPolicy);
    expect(untracked.ok).toBe(false);
    expect(untracked.reasons).toContain("Untracked files are present");
    expect((await preflightRepository(dir, { ...defaultPolicy, allowUntracked: true })).ok).toBe(true);
    await writeFile(join(dir, "tracked.txt"), "edited\n");
    const tracked = await preflightRepository(dir, { ...defaultPolicy, allowUntracked: true });
    expect(tracked.ok).toBe(false);
    expect(tracked.reasons).toContain("Tracked worktree or index changes are present");
    expect(
      (await preflightRepository(dir, { requireRepository: true, requireClean: false, allowUntracked: true })).ok,
    ).toBe(true);
  });
});

describe("Git evidence", () => {
  test("does not attribute unchanged baseline edits and captures new edits", async () => {
    const dir = await repository();
    await writeFile(join(dir, "tracked.txt"), "before\n");
    await writeFile(join(dir, "already here.txt"), "before\n");
    const before = await captureGitState(dir);
    const unchanged = await compareGitStates(before, await captureGitState(dir));
    expect(unchanged.changesSinceBaseline).toEqual([]);
    expect(unchanged.baselineChanges.map((change) => change.path).sort()).toEqual(["already here.txt", "tracked.txt"]);
    await writeFile(join(dir, "worker file.txt"), "after\n");
    const after = await captureGitState(dir);
    const evidence = await compareGitStates(before, after);
    expect(evidence.changesSinceBaseline).toEqual([{ path: "worker file.txt", status: "added" }]);
    expect(evidence.trackedDiffStat).toContain("tracked.txt");
  });

  test("reports removal of a baseline-only untracked file as a deletion", async () => {
    const dir = await repository();
    const path = join(dir, "preexisting.txt");
    await writeFile(path, "preexisting\n");
    const before = await captureGitState(dir);
    await rm(path);
    const evidence = await compareGitStates(before, await captureGitState(dir));
    expect(evidence.baselineChanges).toContainEqual({ path: "preexisting.txt", status: "added" });
    expect(evidence.changesSinceBaseline).toEqual([{ path: "preexisting.txt", status: "deleted" }]);
  });

  test("fails closed when a dirty submodule cannot be fingerprinted", async () => {
    const parent = await repository();
    const child = await repository();
    await command(parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "nested");
    await command(parent, "commit", "-qam", "add submodule");
    await writeFile(join(parent, "nested", "tracked.txt"), "changed inside submodule\n");
    await expect(captureGitState(parent)).rejects.toThrow("Cannot fingerprint directory or special path: nested");
    const preflight = await preflightRepository(parent, {
      requireRepository: false,
      requireClean: false,
      allowUntracked: true,
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.reasons[0]).toContain("Cannot fingerprint directory or special path: nested");
  });

  test("detects a changed baseline file and index-only changes", async () => {
    const dir = await repository();
    await writeFile(join(dir, "tracked.txt"), "before\n");
    const before = await captureGitState(dir);
    await writeFile(join(dir, "tracked.txt"), "after\n");
    const edited = await captureGitState(dir);
    expect((await compareGitStates(before, edited)).changesSinceBaseline).toEqual([
      { path: "tracked.txt", status: "modified" },
    ]);
    await command(dir, "add", "tracked.txt");
    const staged = await captureGitState(dir);
    expect((await compareGitStates(edited, staged)).changesSinceBaseline).toEqual([
      { path: "tracked.txt", status: "modified" },
    ]);
  });

  test("detects mode-only changes to an already dirty file", async () => {
    const dir = await repository();
    await writeFile(join(dir, "tracked.txt"), "dirty\n");
    const before = await captureGitState(dir);
    await chmod(join(dir, "tracked.txt"), 0o755);
    const after = await captureGitState(dir);
    expect((await compareGitStates(before, after)).changesSinceBaseline).toEqual([
      { path: "tracked.txt", status: "modified" },
    ]);
  });

  test("handles filenames with newlines and renames", async () => {
    const dir = await repository();
    const before = await captureGitState(dir);
    await writeFile(join(dir, "new\nline.txt"), "content");
    await command(dir, "mv", "tracked.txt", "renamed.txt");
    const after = await captureGitState(dir);
    const changes = (await compareGitStates(before, after)).changesSinceBaseline;
    expect(changes).toContainEqual({ path: "new\nline.txt", status: "added" });
    expect(changes).toContainEqual({ path: "renamed.txt", status: "renamed" });
  });

  test("attributes committed changes even when the final worktree is clean", async () => {
    const dir = await repository();
    const before = await captureGitState(dir);
    await writeFile(join(dir, "tracked.txt"), "committed\n");
    await command(dir, "add", "tracked.txt");
    await command(dir, "commit", "-qm", "worker change");
    const after = await captureGitState(dir);
    expect(after.entries).toEqual([]);
    const evidence = await compareGitStates(before, after);
    expect(evidence.headChanged).toBe(true);
    expect(evidence.changesSinceBaseline).toEqual([{ path: "tracked.txt", status: "modified" }]);
    expect(evidence.trackedDiffStat).toContain("tracked.txt");
  });

  test("detects an initial commit from an unborn repository", async () => {
    const dir = await mkdtemp("/private/tmp/harness-unborn-test-");
    dirs.push(dir);
    await command(dir, "init", "-q");
    await command(dir, "config", "user.email", "test@example.com");
    await command(dir, "config", "user.name", "Test");
    const before = await captureGitState(dir);
    expect(before.head).toBeNull();
    await writeFile(join(dir, "first.txt"), "initial\n");
    await command(dir, "add", "first.txt");
    await command(dir, "commit", "-qm", "initial");
    const evidence = await compareGitStates(before, await captureGitState(dir));
    expect(evidence.changesSinceBaseline).toEqual([{ path: "first.txt", status: "added" }]);
    expect(evidence.trackedDiffStat).toContain("first.txt");
  });

  test("rejects states from different repositories", async () => {
    const left = await repository();
    const right = await repository();
    await expect(compareGitStates(await captureGitState(left), await captureGitState(right))).rejects.toThrow(
      "different repositories",
    );
  });
});

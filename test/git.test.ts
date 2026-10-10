import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChefError } from "../extension/domain.ts";
import { diffstat, ensureWorktree, gitFacts, inspectRepo, removeWorktree } from "../extension/git.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function makeRepo(dir: string): string {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@t");
  sh(repo, "config", "user.name", "t");
  sh(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "hi\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  return repo;
}

async function withRepo(run: (dir: string, repo: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "chef-git-"));
  try {
    await run(dir, makeRepo(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function commitIn(wt: string, name: string): void {
  writeFileSync(join(wt, name), `${name}\n`);
  sh(wt, "add", name);
  sh(wt, "commit", "-qm", name);
}

test("inspectRepo returns the root from inside a subdirectory and the current branch as base", async () => {
  await withRepo(async (_dir, repo) => {
    mkdirSync(join(repo, "sub"));
    const info = await inspectRepo(join(repo, "sub"));
    assert.equal(info.root, repo);
    assert.equal(info.baseBranch, "main");
    await assert.rejects(inspectRepo(join(repo, "missing")), ChefError);
  });
});

test("ensureWorktree creates chef/<id> from the base, and a second call is a no-op", async () => {
  await withRepo(async (dir, repo) => {
    const wt = join(dir, "wt", "api-1");
    await ensureWorktree(repo, wt, "chef/api-1", "main");
    assert.equal(sh(wt, "rev-parse", "--abbrev-ref", "HEAD"), "chef/api-1");
    assert.equal(sh(wt, "rev-parse", "HEAD"), sh(repo, "rev-parse", "main"));
    commitIn(wt, "a.txt");
    await ensureWorktree(repo, wt, "chef/api-1", "main");
    assert.equal(sh(wt, "rev-list", "--count", "main..HEAD"), "1");
  });
});

test("ensureWorktree re-attaches an existing branch after its worktree was removed", async () => {
  await withRepo(async (dir, repo) => {
    const wt = join(dir, "wt", "api-1");
    await ensureWorktree(repo, wt, "chef/api-1", "main");
    commitIn(wt, "a.txt");
    sh(repo, "worktree", "remove", "--force", wt);
    await ensureWorktree(repo, wt, "chef/api-1", "main");
    assert.equal(sh(wt, "rev-list", "--count", "main..HEAD"), "1");
  });
});

test("ensureWorktree refuses a path that is not a linked worktree of the repo", async () => {
  await withRepo(async (dir, repo) => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    await assert.rejects(ensureWorktree(repo, plain, "chef/x", "main"), ChefError);
    await assert.rejects(ensureWorktree(repo, repo, "chef/x", "main"), ChefError);
    mkdirSync(join(dir, "o"));
    const other = makeRepo(join(dir, "o"));
    await assert.rejects(ensureWorktree(repo, other, "chef/x", "main"), /another repository/);
  });
});

test("gitFacts: a commit merged into base is landed, an unmerged one is ahead and unlanded", async () => {
  await withRepo(async (dir, repo) => {
    const wt = join(dir, "wt", "api-1");
    await ensureWorktree(repo, wt, "chef/api-1", "main");
    assert.deepEqual(await gitFacts(repo, wt, "chef/api-1", "main"), { dirtyFiles: 0, ahead: 0, unlanded: 0 });
    commitIn(wt, "a.txt");
    assert.deepEqual(await gitFacts(repo, wt, "chef/api-1", "main"), { dirtyFiles: 0, ahead: 1, unlanded: 1 });
    assert.match(await diffstat(repo, "chef/api-1", "main"), /a\.txt \| 1 \+/);
    sh(repo, "merge", "-q", "--ff-only", "chef/api-1");
    assert.deepEqual(await gitFacts(repo, wt, "chef/api-1", "main"), { dirtyFiles: 0, ahead: 0, unlanded: 0 });
    assert.equal(await gitFacts(repo, join(dir, "gone"), "chef/api-1", "main"), undefined);
  });
});

test("gitFacts: a commit pushed to a remote branch is landed, an unpushed one is not", async () => {
  await withRepo(async (dir, repo) => {
    const remote = join(dir, "remote.git");
    sh(dir, "init", "-q", "--bare", remote);
    sh(repo, "remote", "add", "origin", remote);
    const wt = join(dir, "wt", "api-1");
    await ensureWorktree(repo, wt, "chef/api-1", "main");
    commitIn(wt, "a.txt");
    sh(wt, "push", "-q", "origin", "chef/api-1");
    assert.deepEqual(await gitFacts(repo, wt, "chef/api-1", "main"), { dirtyFiles: 0, ahead: 1, unlanded: 0 });
    commitIn(wt, "b.txt");
    assert.deepEqual(await gitFacts(repo, wt, "chef/api-1", "main"), { dirtyFiles: 0, ahead: 2, unlanded: 1 });
  });
});

test("gitFacts: ignored files do not make the worktree dirty, tracked changes do", async () => {
  await withRepo(async (dir, repo) => {
    writeFileSync(join(repo, ".gitignore"), "build/\n");
    sh(repo, "add", ".gitignore");
    sh(repo, "commit", "-qm", "ignore");
    const wt = join(dir, "wt", "api-1");
    await ensureWorktree(repo, wt, "chef/api-1", "main");
    mkdirSync(join(wt, "build"));
    writeFileSync(join(wt, "build", "out"), "x");
    assert.equal((await gitFacts(repo, wt, "chef/api-1", "main"))!.dirtyFiles, 0);
    writeFileSync(join(wt, "README.md"), "changed\n");
    writeFileSync(join(wt, "new.txt"), "new\n");
    assert.equal((await gitFacts(repo, wt, "chef/api-1", "main"))!.dirtyFiles, 2);
  });
});

test("removeWorktree twice is success, keeps an unmerged branch without discard, and deletes it with discard", async () => {
  await withRepo(async (dir, repo) => {
    const wt = join(dir, "wt", "api-1");
    await ensureWorktree(repo, wt, "chef/api-1", "main");
    commitIn(wt, "a.txt");
    await removeWorktree(repo, wt, "chef/api-1", false);
    assert.equal(existsSync(wt), false);
    assert.equal(sh(repo, "branch", "--list", "chef/api-1"), "chef/api-1");
    await removeWorktree(repo, wt, "chef/api-1", false);
    await removeWorktree(repo, wt, "chef/api-1", true);
    assert.equal(sh(repo, "branch", "--list", "chef/api-1"), "");
    await ensureWorktree(repo, wt, "chef/api-2", "main");
    writeFileSync(join(wt, "dirty.txt"), "x");
    await assert.rejects(removeWorktree(repo, wt, "chef/api-2", false), ChefError);
    await removeWorktree(repo, wt, "chef/api-2", true);
    assert.equal(existsSync(wt), false);
  });
});

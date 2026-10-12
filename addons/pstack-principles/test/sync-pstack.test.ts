import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { git, makeRepo } from "../../../test/support.ts";

const SYNC = join(import.meta.dirname, "..", "sync-pstack.mjs");

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(dir, path)] = readFileSync(path, "utf8");
  }
  return files;
}

function fixture(): { home: string; checkout: string; out: string } {
  const home = mkdtempSync(join(tmpdir(), "chef-sync-"));
  const checkout = makeRepo(home, "cursor-plugins");
  put(join(checkout, "pstack/LICENSE"), "MIT fixture license\n");
  put(join(checkout, "pstack/skills/principle-alpha/SKILL.md"), "alpha\n");
  put(join(checkout, "pstack/skills/principle-beta/SKILL.md"), "beta\n");
  put(join(checkout, "pstack/skills/principle-beta/references/note.md"), "beta note\n");
  put(join(checkout, "pstack/skills/tdd/SKILL.md"), "not a principle\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "pstack");
  const out = join(home, "principles");
  put(join(out, "principle-gone/SKILL.md"), "removed upstream\n");
  put(join(out, "principle-alpha/stale.md"), "an old file inside a kept principle\n");
  return { home, checkout, out };
}

const sync = (checkout: string, out: string) => spawnSync(process.execPath, [SYNC, checkout, out], { encoding: "utf8" });

test("sync-pstack vendors every upstream principle and the license, drops what upstream removed, and a second run changes nothing", () => {
  const { home, checkout, out } = fixture();
  try {
    const first = sync(checkout, out);
    assert.equal(first.status, 0, first.stderr);
    const sha = git(checkout, "rev-parse", "HEAD");
    const after = tree(out);
    assert.deepEqual(Object.keys(after).sort(), ["LICENSE", "SOURCE.md", "principle-alpha/SKILL.md", "principle-beta/SKILL.md", "principle-beta/references/note.md"]);
    assert.equal(after["principle-beta/references/note.md"], "beta note\n");
    assert.equal(after["LICENSE"], "MIT fixture license\n");
    assert.match(after["SOURCE.md"]!, new RegExp(`Commit: ${sha}\n`));
    assert.match(after["SOURCE.md"]!, /https:\/\/github\.com\/cursor\/plugins\/tree\/main\/pstack/);
    assert.match(after["SOURCE.md"]!, /Do not edit these files by hand; rerun addons\/pstack-principles\/sync-pstack\.mjs/);

    const second = sync(checkout, out);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(tree(out), after, "a second run converges to the same files");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sync-pstack refuses a directory without pstack principles and leaves the vendored files alone", () => {
  const { home, out } = fixture();
  try {
    const before = tree(out);
    const empty = join(home, "empty");
    mkdirSync(empty);
    const run = sync(empty, out);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /no pstack\/skills\/principle-\* directories/);
    assert.deepEqual(tree(out), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

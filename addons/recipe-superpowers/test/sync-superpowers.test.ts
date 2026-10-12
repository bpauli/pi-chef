import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { git, makeRepo } from "../../../test/support.ts";
import { SUPERPOWERS_SKILLS } from "../superpowers.ts";

const SYNC = join(import.meta.dirname, "..", "sync-superpowers.mjs");
const CHOSEN = [...new Set([...SUPERPOWERS_SKILLS.chef, ...SUPERPOWERS_SKILLS.cook])].sort();

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

function fixture(skills: readonly string[] = CHOSEN): { home: string; checkout: string; out: string } {
  const home = mkdtempSync(join(tmpdir(), "chef-sync-superpowers-"));
  const checkout = makeRepo(home, "superpowers");
  put(join(checkout, "LICENSE"), "MIT fixture license\n");
  for (const name of skills) put(join(checkout, "skills", name, "SKILL.md"), `${name}\n`);
  put(join(checkout, "skills", "brainstorming", "scripts", "helper.js"), "companion\n");
  put(join(checkout, "skills", "writing-skills", "SKILL.md"), "a meta skill, not chosen\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "superpowers");
  const out = join(home, "principles");
  put(join(out, "using-git-worktrees", "SKILL.md"), "chosen before, not now\n");
  put(join(out, "test-driven-development", "stale.md"), "an old file inside a kept skill\n");
  return { home, checkout, out };
}

const sync = (checkout: string, out: string) => spawnSync(process.execPath, [SYNC, checkout, out], { encoding: "utf8" });

test("sync-superpowers vendors the chosen skills with their companion files and the license, drops a skill that is no longer chosen, and a second run changes nothing", () => {
  const { home, checkout, out } = fixture();
  try {
    const first = sync(checkout, out);
    assert.equal(first.status, 0, first.stderr);
    const after = tree(out);
    assert.deepEqual(Object.keys(after).sort(), ["LICENSE", "SOURCE.md", ...CHOSEN.map((n) => `${n}/SKILL.md`), "brainstorming/scripts/helper.js"].sort());
    assert.equal(after["brainstorming/scripts/helper.js"], "companion\n");
    assert.equal(after["LICENSE"], "MIT fixture license\n");
    assert.match(after["SOURCE.md"]!, new RegExp(`Commit: ${git(checkout, "rev-parse", "HEAD")}\n`));
    assert.match(after["SOURCE.md"]!, /https:\/\/github\.com\/obra\/superpowers/);
    assert.match(after["SOURCE.md"]!, /Jesse Vincent/);

    const second = sync(checkout, out);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(tree(out), after, "a second run converges to the same files");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sync-superpowers refuses a checkout that lacks a chosen skill and leaves the vendored files alone", () => {
  const { home, checkout, out } = fixture(CHOSEN.filter((n) => n !== "systematic-debugging"));
  try {
    const before = tree(out);
    const run = sync(checkout, out);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /no skills\/<name>\/SKILL\.md for: systematic-debugging/);
    assert.deepEqual(tree(out), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

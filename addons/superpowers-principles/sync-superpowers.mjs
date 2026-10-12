#!/usr/bin/env node
// Vendors the chosen superpowers skills into addons/superpowers-principles/principles/.
// Usage: node addons/superpowers-principles/sync-superpowers.mjs <obra/superpowers checkout> [out dir]
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const UPSTREAM = "https://github.com/obra/superpowers";
// The README of this add-on says why each skill is in or out. Keep both in step.
const SKILLS = [
  "brainstorming",
  "dispatching-parallel-agents",
  "executing-plans",
  "receiving-code-review",
  "requesting-code-review",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development",
  "verification-before-completion",
  "writing-plans",
];

const [checkout, outArg] = process.argv.slice(2);
if (!checkout) {
  console.error("Usage: node addons/superpowers-principles/sync-superpowers.mjs <obra/superpowers checkout> [out dir]");
  process.exit(2);
}
const out = resolve(outArg ?? join(import.meta.dirname, "principles"));
const skills = join(checkout, "skills");

const missing = SKILLS.filter((name) => !existsSync(join(skills, name, "SKILL.md")));
if (missing.length) {
  console.error(`${checkout} has no skills/<name>/SKILL.md for: ${missing.join(", ")}. Nothing changed.`);
  process.exit(1);
}

const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
const sha = git("rev-parse", "HEAD");
const date = git("log", "-1", "--format=%cs", sha);

mkdirSync(out, { recursive: true });
// Delete and copy again, so a file or a skill that is no longer chosen does not stay behind.
for (const entry of readdirSync(out, { withFileTypes: true })) if (entry.isDirectory()) rmSync(join(out, entry.name), { recursive: true, force: true });
for (const name of SKILLS) cpSync(join(skills, name), join(out, name), { recursive: true });
cpSync(join(checkout, "LICENSE"), join(out, "LICENSE"));
writeFileSync(
  join(out, "SOURCE.md"),
  [
    "# Source",
    "",
    "These skills are vendored from superpowers by Jesse Vincent, under the MIT license in `LICENSE`.",
    "",
    `Upstream: ${UPSTREAM}`,
    `Commit: ${sha}`,
    `Date: ${date}`,
    `Skills: ${SKILLS.join(", ")}`,
    "",
    "Do not edit these files by hand; rerun addons/superpowers-principles/sync-superpowers.mjs with an obra/superpowers checkout.",
    "",
  ].join("\n"),
);
console.log(`Vendored ${SKILLS.length} skills from ${sha.slice(0, 7)} into ${out}.`);

#!/usr/bin/env node
// Vendors the pstack principle skills into addons/principles/principles/.
// Usage: node addons/principles/sync-pstack.mjs <cursor-plugins checkout> [out dir]
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const UPSTREAM = "https://github.com/cursor/plugins/tree/main/pstack";
const [checkout, outArg] = process.argv.slice(2);
if (!checkout) {
  console.error("Usage: node addons/principles/sync-pstack.mjs <cursor-plugins checkout> [out dir]");
  process.exit(2);
}
const out = resolve(outArg ?? join(import.meta.dirname, "principles"));
const skills = join(checkout, "pstack", "skills");
const isPrinciple = (name) => name.startsWith("principle-");

let upstream = [];
try {
  upstream = readdirSync(skills, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isPrinciple(e.name))
    .map((e) => e.name)
    .sort();
} catch {}
if (!upstream.length) {
  console.error(`${checkout} has no pstack/skills/principle-* directories. Nothing changed.`);
  process.exit(1);
}

const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
const sha = git("rev-parse", "HEAD");
const date = git("log", "-1", "--format=%cs", sha);

mkdirSync(out, { recursive: true });
// Delete and copy again, so a file or principle that upstream removed does not stay behind.
for (const name of readdirSync(out)) if (isPrinciple(name)) rmSync(join(out, name), { recursive: true, force: true });
for (const name of upstream) cpSync(join(skills, name), join(out, name), { recursive: true });
cpSync(join(checkout, "pstack", "LICENSE"), join(out, "LICENSE"));
writeFileSync(
  join(out, "SOURCE.md"),
  [
    "# Source",
    "",
    "These principle skills are vendored from pstack by Lauren Tan, under the MIT license in `LICENSE`.",
    "",
    `Upstream: ${UPSTREAM}`,
    `Commit: ${sha}`,
    `Date: ${date}`,
    "",
    "Do not edit these files by hand; rerun addons/principles/sync-pstack.mjs with a cursor/plugins checkout.",
    "",
  ].join("\n"),
);
console.log(`Vendored ${upstream.length} principles from ${sha.slice(0, 7)} into ${out}.`);

#!/usr/bin/env node
// Usage: node scripts/npm-publish.mjs [--dry-run]
// Publishes each package whose version is not on npm yet. A version that is on npm must come from
// this commit, else the script fails: npm versions are immutable, so a second build of one version
// is a release defect, not something to skip.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGES } from "./packages.mjs";

const dryRun = process.argv.includes("--dry-run");
const fail = (message) => {
  console.error(`npm-publish: ${message}`);
  process.exit(1);
};

const head = execFileSync("git", ["rev-parse", "HEAD^{commit}"], { encoding: "utf8" }).trim();
const [major, minor, patch] = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim().split(".").map(Number);
if (!dryRun && (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1))))) fail(`npm ${major}.${minor}.${patch} cannot use Trusted Publishing. It needs npm 11.5.1 or later.`);

function published(name, version) {
  try {
    return JSON.parse(execFileSync("npm", ["view", `${name}@${version}`, "version", "gitHead", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) || "null");
  } catch (e) {
    if (/E404/.test(String(e.stderr))) return null;
    throw e;
  }
}

for (const { dir } of PACKAGES) {
  const { name, version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const existing = published(name, version);
  if (existing) {
    if (existing.gitHead !== head) fail(`${name}@${version} is on npm from commit ${existing.gitHead ?? "unknown"}, not ${head}. Release a new version.`);
    console.log(`npm-publish: ${name}@${version} is already on npm from this commit.`);
    continue;
  }
  execFileSync("npm", ["publish", "--access", "public", ...(dryRun ? ["--dry-run"] : [])], { cwd: dir, stdio: "inherit" });
  console.log(`npm-publish: ${dryRun ? "would publish" : "published"} ${name}@${version}.`);
}

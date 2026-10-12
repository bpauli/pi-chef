#!/usr/bin/env node
// Usage: node scripts/release-preflight.mjs <tag> [out dir]
// Checks that a release tag agrees with every package version and with CHANGELOG.md,
// then writes release-title.txt and release-notes.md into the out dir.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [tag, outDir = "."] = process.argv.slice(2);
const fail = (message) => {
  console.error(`release-preflight: ${message}`);
  process.exit(1);
};

if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) fail(`the tag must look like v1.2.3, got ${tag ?? "nothing"}.`);
const version = tag.slice(1);

// In GitHub Actions, prove that the checkout is the tagged commit and not a moved branch.
if (process.env.GITHUB_ACTIONS === "true") {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  if (process.env.GITHUB_REF !== `refs/tags/${tag}`) fail(`the run must be for refs/tags/${tag}, got ${process.env.GITHUB_REF}.`);
  const head = git("rev-parse", "HEAD^{commit}");
  const tagged = git("rev-parse", `refs/tags/${tag}^{commit}`);
  if (head !== tagged || process.env.GITHUB_SHA !== tagged) fail(`the checkout is not the tag commit: head ${head}, tag ${tagged}, event ${process.env.GITHUB_SHA}.`);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const manifests = ["package.json", ...readdirSync("addons").map((a) => join("addons", a, "package.json")).filter(existsSync)];
const wrong = manifests.filter((path) => readJson(path).version !== version);
if (wrong.length) fail(`these manifests do not have version ${version}: ${wrong.join(", ")}.`);
const lock = readJson("package-lock.json");
if (lock.version !== version || lock.packages?.[""]?.version !== version) fail(`package-lock.json does not have version ${version}. Run npm install.`);

const changelog = readFileSync("CHANGELOG.md", "utf8");
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const section = changelog.match(new RegExp(`^##\\s+(${escaped}(?:[ \\t][^\\n]*)?)\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "m"));
if (!section) fail(`CHANGELOG.md has no section "## ${version}".`);
const title = section[1].trim();
const notes = section[2].trim();
if (!notes) fail(`the CHANGELOG.md section for ${version} is empty.`);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "release-title.txt"), `${title}\n`);
writeFileSync(join(outDir, "release-notes.md"), `${notes}\n`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
console.log(`release-preflight: ${tag} agrees with ${manifests.length} manifests, package-lock.json, and CHANGELOG.md ("${title}").`);

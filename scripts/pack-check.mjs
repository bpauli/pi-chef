#!/usr/bin/env node
// Usage: node scripts/pack-check.mjs
// Packs each published package, checks its file list, and loads its Pi extension from the unpacked tarball.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PI_CLI = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const PACKAGES = [
  { dir: ".", must: ["LICENSE", "README.md", "package.json", "extension/index.ts", "extension/watch.ts", "skills/chef/SKILL.md"] },
  { dir: "addons/herdr", must: ["LICENSE", "README.md", "package.json", "index.ts", "herdr.ts"] },
  { dir: "addons/subagents", must: ["LICENSE", "README.md", "package.json", "index.ts", "fleet.ts"] },
  { dir: "addons/recipe-pstack", must: ["LICENSE", "README.md", "package.json", "index.ts", "principles.ts", "principles/LICENSE"] },
  { dir: "addons/recipe-superpowers", must: ["LICENSE", "README.md", "package.json", "index.ts", "superpowers.ts", "principles/LICENSE"] },
];
const FORBIDDEN = /^(test|addons|node_modules|\.github|scripts|docs\/assets)\/|^(todo\.md|decisions\.tsv|out\.txt|AGENTS\.md|tsconfig\.json)$|\.test\.ts$/;
const MARKER = "pack-check-loaded";

const fail = (message) => {
  console.error(`pack-check: ${message}`);
  process.exit(1);
};

const work = mkdtempSync(join(tmpdir(), "pi-chef-pack-"));
try {
  for (const { dir, must } of PACKAGES) {
    const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: dir, encoding: "utf8" }));
    const files = pack.files.map((f) => f.path);
    const missing = must.filter((f) => !files.includes(f));
    if (missing.length) fail(`${pack.name} misses ${missing.join(", ")}.`);
    const forbidden = files.filter((f) => FORBIDDEN.test(f));
    if (forbidden.length) fail(`${pack.name} must not ship ${forbidden.join(", ")}.`);

    const unpacked = join(work, pack.name);
    execFileSync("mkdir", ["-p", unpacked]);
    execFileSync("tar", ["-xzf", join(work, pack.filename), "-C", unpacked]);
    const root = join(unpacked, "package");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (!manifest.keywords?.includes("pi-package")) fail(`${pack.name} has no pi-package keyword, so the pi.dev gallery does not list it.`);
    if (manifest.private) fail(`${pack.name} is private, so npm refuses to publish it.`);
    for (const entry of manifest.pi.extensions) {
      // The probe registers its flag only after the packed extension imported and ran, so a missing file fails here.
      const probe = join(unpacked, "probe.ts");
      writeFileSync(probe, `import ext from ${JSON.stringify(join(root, entry))};\nexport default function (pi) { ext(pi); pi.registerFlag(${JSON.stringify(MARKER)}, { type: "boolean", description: "probe" }); }\n`);
      const help = execFileSync(process.execPath, [PI_CLI, "-e", probe, "--help"], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: join(unpacked, "agent") } });
      if (!help.includes(MARKER)) fail(`${pack.name} ${entry} does not load from its tarball.`);
    }
    console.log(`pack-check: ${pack.name}@${pack.version} ships ${files.length} files (${pack.size} bytes packed) and loads in Pi.`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

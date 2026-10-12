#!/usr/bin/env node
// Usage: node scripts/pack-check.mjs
// Packs each published package, checks its file list, and loads its Pi extension from the unpacked tarball.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { WATCH_SCRIPT } from "../extension/events.ts";
import { PACKAGES } from "./packages.mjs";

const PI_CLI = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
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

    // Unpacked under node_modules, where `pi install npm:` puts it: Node strips no types there.
    const unpacked = join(work, pack.name);
    const root = join(unpacked, "node_modules", pack.name);
    execFileSync("mkdir", ["-p", root]);
    execFileSync("tar", ["-xzf", join(work, pack.filename), "-C", root, "--strip-components=1"]);
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
    if (dir === ".") {
      const taskDir = join(unpacked, "task");
      execFileSync("mkdir", ["-p", join(taskDir, "runs")]);
      writeFileSync(join(taskDir, "log.jsonl"), `${JSON.stringify({ type: "closed" })}\n`);
      const viewer = join(root, relative(process.cwd(), WATCH_SCRIPT));
      let shown;
      try {
        shown = execFileSync(process.execPath, [viewer, taskDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
      } catch (e) {
        fail(`${pack.name} viewer ${relative(root, viewer)} does not run under node_modules: ${String(e.stderr).split("\n").find((l) => l.includes("Error")) ?? e.message}`);
      }
      if (!shown.includes("task closed")) fail(`${pack.name} viewer did not end on a closed task.`);
    }
    console.log(`pack-check: ${pack.name}@${pack.version} ships ${files.length} files (${pack.size} bytes packed) and loads in Pi.`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

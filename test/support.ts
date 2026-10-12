import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// A test run inside herdr would otherwise let every chef it starts open tabs in the human's live herdr session.
for (const key of Object.keys(process.env)) if (key.startsWith("HERDR_")) delete process.env[key];

export const ROOT = resolve(import.meta.dirname, "..");
export const PI_CLI = join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
export const CHEF_ENTRY = join(ROOT, "extension/index.ts");
export const FAKE_PROVIDER = join(ROOT, "test/fake-model/provider.ts");
export const SLOW_EXIT = join(ROOT, "test/slow-exit.ts");
export const NEVER_EXIT = join(ROOT, "test/never-exit.ts");
export const FAKE_HERDR = join(ROOT, "addons/herdr/test/fake-herdr.mjs");
export const HERDR_ADDON = join(ROOT, "addons/herdr/index.ts");
export const SUBAGENTS_ADDON = join(ROOT, "addons/subagents/index.ts");
export const PSTACK_PRINCIPLES_ADDON = join(ROOT, "addons/pstack-principles/index.ts");
export const SUPERPOWERS_PRINCIPLES_ADDON = join(ROOT, "addons/superpowers-principles/index.ts");

/** Installs a fake pi-subagents under an npm root, the way Pi lays out an npm package. Returns the path of its external-runs module. */
export function installFakeSubagents(npmRoot: string): string {
  const dir = join(npmRoot, "node_modules", "pi-subagents");
  mkdirSync(join(dir, "src", "api"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "pi-subagents", type: "module", exports: { "./external-runs": { types: "./src/api/external-runs.d.ts", default: "./src/api/external-runs.js" } } }),
  );
  const module = join(dir, "src", "api", "external-runs.js");
  copyFileSync(join(ROOT, "addons/subagents/test/fake-external-runs.mjs"), module);
  return module;
}
export const COOKS_RECORDER = join(ROOT, "test/cooks-recorder.ts");
export const ROLE_RECORDER = join(ROOT, "test/role-recorder.ts");
export const FAKE_MODEL = "fake/scripted";

export async function startFakeModel(): Promise<{ port: string; stop(): void }> {
  const server = spawn(process.execPath, [join(ROOT, "test/fake-model/server.mjs")], { env: { ...process.env, FAKE_MODEL_PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((ok) => server.stdout.once("data", (d) => ok(String(d).trim())));
  process.env.FAKE_MODEL_PORT = port;
  return { port, stop: () => server.kill() };
}

export interface TempKitchen {
  home: string;
  kitchenDir: string;
  agentDir: string;
  dispose(): void;
}

export function tempKitchen(config: Record<string, unknown> = {}): TempKitchen {
  const home = mkdtempSync(join(tmpdir(), "chef-e2e-"));
  const kitchenDir = join(home, "kitchen");
  const agentDir = join(home, "agent");
  mkdirSync(kitchenDir);
  mkdirSync(agentDir);
  writeFileSync(join(kitchenDir, "config.json"), JSON.stringify({ model: FAKE_MODEL, cookArgs: ["-e", FAKE_PROVIDER], ...config }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.CHEF_HOME = kitchenDir;
  return { home, kitchenDir, agentDir, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

export const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function makeRepo(dir: string, name: string): string {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), `${name}\n`);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  return repo;
}

export const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

export async function until<T>(what: string, step: () => Promise<T | undefined> | T | undefined, timeoutMs = 30_000, everyMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await step();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

export const COMMIT_STEP = (file: string) => `STEP bash: echo ${file} > ${file} && git add ${file} && git commit -qm "add ${file}"`;
export const REPORT_STEP = (status: string, summary: string) => `STEP tool chef_report ${JSON.stringify({ status, summary })}`;

// Shared setup for the e2e tests: the fake model server, a temp kitchen with a
// temp Pi agent dir, temp git repos, and polling helpers.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");
export const PI_CLI = join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
export const CHEF_ENTRY = join(ROOT, "extension/index.ts");
export const FAKE_PROVIDER = join(ROOT, "test/fake-model/provider.ts");
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

/** A fresh kitchen and agent dir. Sets PI_CODING_AGENT_DIR and CHEF_HOME so cooks inherit them. */
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

/** Polls `step` until it returns a value, or fails with `what` after `timeoutMs`. */
export async function until<T>(what: string, step: () => Promise<T | undefined> | T | undefined, timeoutMs = 30_000, everyMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await step();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** Fake-model script lines for a cook: one commit then a done report. */
export const COMMIT_STEP = (file: string) => `STEP bash: echo ${file} > ${file} && git add ${file} && git commit -qm "add ${file}"`;
export const REPORT_STEP = (status: string, summary: string) => `STEP tool chef_report ${JSON.stringify({ status, summary })}`;

// Records real Pi 1.0.3 JSONL streams on the fake model as fold fixtures. The
// cook runs the real cook role (extension/index.ts with CHEF_ROLE=cook) on a
// temp task dir. Usage: node test/fixtures/record.mjs
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const pi = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const entry = join(root, "extension/index.ts");
const provider = join(root, "test/fake-model/provider.ts");

const scripts = {
  done: 'task\nSTEP bash: echo hello\nSTEP tool chef_report {"status":"done","summary":"echoed hello"}',
  "needs-decision": 'task\nSTEP tool chef_report {"status":"needs_decision","summary":"cookie or bearer token?"}',
  "no-report": "task\nSTEP bash: echo x\nSTEP say: finished without a report",
  "provider-error": "task\nSTEP say: never reached",
};

const server = spawn(process.execPath, [join(root, "test/fake-model/server.mjs")], { env: { ...process.env, FAKE_MODEL_PORT: "0" } });
const port = await new Promise((ok) => server.stdout.once("data", (d) => ok(String(d).trim())));

for (const [name, script] of Object.entries(scripts)) {
  const home = mkdtempSync(join(tmpdir(), "chef-record-"));
  const taskDir = join(home, "task");
  mkdirSync(join(taskDir, "inbox", "handled"), { recursive: true });
  const spec = { id: "api-1", project: "api", title: "record", brief: script, branch: "chef/api-1", worktree: home, baseBranch: "main", sessionId: `record-${name}`, createdAt: Date.now() };
  writeFileSync(join(taskDir, "task.json"), JSON.stringify(spec));
  const out = openSync(join(root, "test/fixtures", `${name}.jsonl`), "w");
  const fakePort = name === "provider-error" ? "1" : port;
  const args = [pi, "--mode", "json", "-p", "--no-session", "-ne", "-e", provider, "-e", entry, "--model", "fake/scripted", script];
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", out, "inherit"],
    env: { ...process.env, PI_CODING_AGENT_DIR: join(home, "agent"), FAKE_MODEL_PORT: fakePort, CHEF_ROLE: "cook", CHEF_TASK_DIR: taskDir },
    cwd: home,
  });
  const code = await new Promise((ok) => child.on("exit", ok));
  closeSync(out);
  rmSync(home, { recursive: true, force: true });
  console.log(`${name}: exit ${code}`);
}
server.kill();

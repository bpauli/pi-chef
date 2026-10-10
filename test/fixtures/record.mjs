// Records real Pi 1.0.3 JSONL streams on the fake model as fold fixtures.
// Usage: node test/fixtures/record.mjs [extension path, default test/fixtures/report-tool.ts]
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const pi = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const reportExt = resolve(process.argv[2] ?? join(root, "test/fixtures/report-tool.ts"));
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
  const agentDir = mkdtempSync(join(tmpdir(), "chef-record-"));
  const out = openSync(join(root, "test/fixtures", `${name}.jsonl`), "w");
  const fakePort = name === "provider-error" ? "1" : port;
  const args = [pi, "--mode", "json", "-p", "--no-session", "-ne", "-e", provider, "-e", reportExt, "--model", "fake/scripted", script];
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", out, "inherit"],
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, FAKE_MODEL_PORT: fakePort, CHEF_ROLE: "cook", CHEF_TASK_DIR: process.env.CHEF_TASK_DIR ?? "" },
    cwd: agentDir,
  });
  const code = await new Promise((ok) => child.on("exit", ok));
  closeSync(out);
  rmSync(agentDir, { recursive: true, force: true });
  console.log(`${name}: exit ${code}`);
}
server.kill();

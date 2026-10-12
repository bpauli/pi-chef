import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Pid, type TaskSpec, millis, parseProjectName, runNo } from "../extension/domain.ts";
import { type CookEnd, CookTable, alive, cookArgv, firstPrompt, followUpPrompt, launchCook, pidStart, runsSession, signalCook } from "../extension/cooks.ts";

const spec: TaskSpec = {
  id: "api-1" as TaskSpec["id"],
  project: parseProjectName("api"),
  title: "Add limiter",
  brief: "Intent: limit logins.\n",
  branch: "chef/api-1",
  worktree: "/k/worktrees/api-1",
  baseBranch: "main",
  sessionId: "0199-sid" as TaskSpec["sessionId"],
  models: [],
  createdAt: millis(1),
};

function sleeper(sessionId: string): ChildProcess {
  const code = 'require("node:child_process").spawn("sleep", ["30"], { stdio: "ignore" }); setInterval(() => {}, 1000)';
  const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore", env: { ...process.env, CHEF_SESSION_ID: sessionId } });
  child.unref();
  return child;
}

const settle = () => new Promise((ok) => setTimeout(ok, 150));

async function gone(pid: number): Promise<void> {
  for (let i = 0; i < 50 && alive(pid); i++) await settle();
}

test("cookArgv runs the same pi in json print mode on the task session with the chef entry and the prompt file", () => {
  const argv = cookArgv({
    pi: { command: "/bin/node", args: ["/pi/cli.js"] },
    chefEntry: "/chef/extension/index.ts",
    spec,
    run: runNo(2),
    promptFile: "/k/tasks/api-1/runs/2.prompt.md",
    sessionDir: "/k/tasks/api-1/session",
    taskDir: "/k/tasks/api-1",
    profile: { model: "fake/scripted", thinking: "low" },
    config: { maxCooks: 3, models: { rules: [], default: [] }, cookArgs: ["-e", "/x.ts"] },
    fds: { stdout: 0, stderr: 0 },
  });
  assert.deepEqual(argv, [
    "/pi/cli.js", "--mode", "json", "-p", "--session-id", "0199-sid", "--session-dir", "/k/tasks/api-1/session",
    "-e", "/chef/extension/index.ts", "--model", "fake/scripted", "--thinking", "low", "-e", "/x.ts", "@/k/tasks/api-1/runs/2.prompt.md",
  ]);
  const bare = { pi: { command: "/bin/pi", args: [] }, chefEntry: "/c", spec, run: runNo(1), promptFile: "/p", sessionDir: "/s", taskDir: "/t", config: { maxCooks: 3, models: { rules: [], default: [] }, cookArgs: [] }, fds: { stdout: 0, stderr: 0 } };
  const noThinking = cookArgv({ ...bare, profile: { model: "other/model" } });
  assert.deepEqual(noThinking.slice(noThinking.indexOf("--model")), ["--model", "other/model", "@/p"]);
  const piDefault = cookArgv({ ...bare, profile: undefined });
  assert.ok(!piDefault.includes("--model") && !piDefault.includes("--thinking"), "no profile leaves the model to Pi");
});

test("launchCook reports a missing binary through onEnd instead of crashing the process, and closes the claim fds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chef-cooks-"));
  const fds = { stdout: openSync(join(dir, "1.jsonl"), "w"), stderr: openSync(join(dir, "1.err"), "w") };
  const ends: CookEnd[] = [];
  const pid = launchCook(
    { pi: { command: join(dir, "no-such-pi"), args: [] }, chefEntry: "/c", spec: { ...spec, worktree: dir }, run: runNo(1), promptFile: "/p", sessionDir: dir, taskDir: dir, profile: undefined, config: { maxCooks: 3, models: { rules: [], default: [] }, cookArgs: [] }, fds },
    (end) => ends.push(end),
  );
  assert.equal(pid, undefined);
  await settle();
  assert.equal(ends.length, 1);
  assert.match(ends[0]!.kind === "error" ? ends[0]!.message : "", /^spawn of no-such-pi failed: .*ENOENT/);
  assert.throws(() => closeSync(fds.stdout), /EBADF/);
  rmSync(dir, { recursive: true, force: true });
});

test("the first prompt frames the brief with the worktree facts, the follow-up prompt carries only the messages", () => {
  const project = { name: parseProjectName("api"), path: "/r", baseBranch: "main", note: "Go service", addedAt: millis(1) };
  const first = firstPrompt(spec, project, ["use the bucket"]);
  assert.match(first, /^# Add limiter\n\nTask api-1 for project api \(Go service\)\. You work in \/k\/worktrees\/api-1 on branch chef\/api-1, forked from main\.\n\n## Brief\n\nIntent: limit logins\.\n\n## Messages from the chef\n\nuse the bucket\n$/);
  assert.equal(followUpPrompt(["answer: B", "also run tests"]), "## Messages from the chef\n\nanswer: B\n\n---\n\nalso run tests\n");
  assert.doesNotMatch(firstPrompt(spec, project, []), /Messages from the chef/);
});

test("CookTable adopts the group leader of a live cook by its environment marker and drops it once it exits", async () => {
  const sid = `adopt-${process.pid}-${Date.now()}`;
  const child = sleeper(sid);
  await settle();
  const table = new CookTable();
  await table.adopt();
  assert.equal((await table.live()).get(sid), child.pid, "the leader, not its sleep child");
  await signalCook(child.pid as Pid, sid, "SIGTERM");
  await gone(child.pid!);
  assert.equal((await table.live()).has(sid), false);
});

test("a recorded pid whose environment does not name the session is not live (pid reuse guard)", async () => {
  const child = sleeper("some-other-session");
  await settle();
  const table = new CookTable();
  table.record("expected-session", child.pid as Pid);
  assert.equal((await table.live()).size, 0);
  assert.equal(await runsSession(child.pid!, "some-other-session"), true);
  await signalCook(child.pid as Pid, "expected-session", "SIGKILL");
  assert.equal(alive(child.pid!), true, "a wrong session id must not be signalled");
  await signalCook(child.pid as Pid, "some-other-session", "SIGKILL");
  await gone(child.pid!);
  assert.equal(alive(child.pid!), false);
});

test("pidStart is stable for a live process and undefined for a dead one", async () => {
  const a = await pidStart(process.pid);
  assert.ok(a);
  assert.equal(await pidStart(process.pid), a);
  const child = sleeper("start-probe");
  await settle();
  const b = await pidStart(child.pid!);
  assert.ok(b);
  await signalCook(child.pid as Pid, "start-probe", "SIGKILL");
  await gone(child.pid!);
  assert.equal(await pidStart(child.pid!), undefined);
});

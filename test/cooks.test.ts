import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { DEFAULT_CONFIG, type Pid, type TaskId, type TaskSpec, millis, parseProjectName, runNo } from "../extension/domain.ts";
import { type CookEnd, CookTable, alive, cookArgv, firstPrompt, followUpPrompt, launchCook, parseLsof, pidStart, scanCooks } from "../extension/cooks.ts";

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

const task = (s: string) => s as TaskId;

/** The process env without anything chef sets for a cook, so only fd 1 can tell a cook apart. */
const plainEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CHEF_")));

// Mirrors a cook: Pi's title, a child that inherits its stdio, and nothing else to tell it apart.
// "ready" on stderr means the child exists, so a scan right after it sees both processes.
const COOK_CODE = 'process.title = "pi"; require("node:child_process").spawn("sleep", ["30"], { stdio: "inherit" }); process.stderr.write("ready"); setInterval(() => {}, 1000)';

const kitchens: string[] = [];
const fixtures: ChildProcess[] = [];
afterEach(async () => {
  for (const child of fixtures.splice(0)) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
    await gone(child.pid!);
  }
  for (const dir of kitchens.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempTasks(): string {
  const kitchen = mkdtempSync(join(tmpdir(), "chef-cooks-"));
  kitchens.push(kitchen);
  return join(kitchen, "tasks");
}

/** A process in its own group whose descriptor `fd` is the run file `<tasks>/<id>/runs/1.jsonl`. */
async function cookLike(tasks: string, id: TaskId, fd = 1): Promise<ChildProcess> {
  mkdirSync(join(tasks, id, "runs"), { recursive: true });
  const out = openSync(join(tasks, id, "runs", "1.jsonl"), "a");
  const stdio: ("ignore" | "pipe" | number)[] = ["ignore", "ignore", "pipe"];
  stdio[fd] = out;
  const child = spawn(process.execPath, ["-e", COOK_CODE], { detached: true, stdio, env: plainEnv });
  child.unref();
  fixtures.push(child);
  closeSync(out);
  await new Promise((ok) => child.stderr!.once("data", ok));
  child.stderr!.destroy();
  return child;
}

function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
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
    config: { ...DEFAULT_CONFIG, cookArgs: ["-e", "/x.ts"] },
    fds: { stdout: 0, stderr: 0 },
  });
  assert.deepEqual(argv, [
    "/pi/cli.js", "--mode", "json", "-p", "--session-id", "0199-sid", "--session-dir", "/k/tasks/api-1/session",
    "-e", "/chef/extension/index.ts", "--model", "fake/scripted", "--thinking", "low", "-e", "/x.ts", "@/k/tasks/api-1/runs/2.prompt.md",
  ]);
  const bare = { pi: { command: "/bin/pi", args: [] }, chefEntry: "/c", spec, run: runNo(1), promptFile: "/p", sessionDir: "/s", taskDir: "/t", config: { ...DEFAULT_CONFIG, cookArgs: [] }, fds: { stdout: 0, stderr: 0 } };
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
    { pi: { command: join(dir, "no-such-pi"), args: [] }, chefEntry: "/c", spec: { ...spec, worktree: dir }, run: runNo(1), promptFile: "/p", sessionDir: dir, taskDir: dir, profile: undefined, config: { ...DEFAULT_CONFIG, cookArgs: [] }, fds },
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
  const project = { name: parseProjectName("api"), path: "/r", baseBranch: "main", branchPrefix: "chef/", note: "Go service", addedAt: millis(1) };
  const first = firstPrompt(spec, project, ["use the bucket"]);
  assert.match(first, /^# Add limiter\n\nTask api-1 for project api \(Go service\)\. You work in \/k\/worktrees\/api-1 on branch chef\/api-1, forked from main\.\n\n## Brief\n\nIntent: limit logins\.\n\n## Messages from the chef\n\nuse the bucket\n$/);
  assert.equal(followUpPrompt(["answer: B", "also run tests"]), "## Messages from the chef\n\nanswer: B\n\n---\n\nalso run tests\n");
  assert.doesNotMatch(firstPrompt(spec, project, []), /Messages from the chef/);
});

test("CookTable adopts a pi-titled process whose stdout is a run file of the kitchen, not its child that shares that stdout, and drops it once it exits", async () => {
  const tasks = tempTasks();
  const child = await cookLike(tasks, task("api-1"));
  const table = new CookTable(tasks);
  await table.adopt();
  assert.equal((await table.live()).get(task("api-1")), child.pid, "the leader, not its sleep child");
  await table.signal(task("api-1"), child.pid as Pid, "SIGTERM");
  await gone(child.pid!);
  assert.equal((await table.live()).has(task("api-1")), false);
});

test("a cook under a symlinked tasks dir is found through the link and through the real path", async () => {
  const real = tempTasks();
  mkdirSync(real);
  const link = join(dirname(real), "link");
  symlinkSync(realpathSync(real), link);
  const child = await cookLike(link, task("web-3"));
  const viaLink = new CookTable(link);
  await viaLink.adopt();
  assert.equal((await viaLink.live()).get(task("web-3")), child.pid, "the kitchen path is a symlink, the OS reports the real path");
  assert.equal((await scanCooks(real)).get(task("web-3")), child.pid);
  await viaLink.signal(task("web-3"), child.pid as Pid, "SIGKILL");
  await gone(child.pid!);
});

test("a recorded pid whose stdout is another task's run file is not live and is not signalled (pid reuse guard)", async () => {
  const tasks = tempTasks();
  const child = await cookLike(tasks, task("web-2"));
  const table = new CookTable(tasks);
  table.record(task("api-1"), child.pid as Pid);
  assert.deepEqual([...(await table.live())], []);
  await table.signal(task("api-1"), child.pid as Pid, "SIGKILL");
  assert.equal(alive(child.pid!), true, "a pid that cooks another task must not be signalled");
  await table.signal(task("web-2"), child.pid as Pid, "SIGKILL");
  await gone(child.pid!);
  assert.equal(alive(child.pid!), false);
});

test("a process that holds a run file on a descriptor other than 1 is not a cook", async () => {
  const tasks = tempTasks();
  const holder = await cookLike(tasks, task("api-1"), 3);
  assert.deepEqual([...(await scanCooks(tasks))], []);
});

test("parseLsof reads pid, ppid, and the fd 1 path from lsof -F pRn output, with and without the f line", () => {
  const macos = "p3141\nR3140\nf1\nn/private/var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T/chef-fd-BhJoPR/1.jsonl\n";
  assert.deepEqual(parseLsof(macos), [{ pid: 3141, ppid: 3140, path: "/private/var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T/chef-fd-BhJoPR/1.jsonl" }]);
  const linux = "p387192\nR11668\nn/tmp/k/tasks/api-1/runs/1.jsonl\np9\nR1\nn/dev/pts/0\n";
  assert.deepEqual(parseLsof(linux), [
    { pid: 387192, ppid: 11668, path: "/tmp/k/tasks/api-1/runs/1.jsonl" },
    { pid: 9, ppid: 1, path: "/dev/pts/0" },
  ]);
  assert.deepEqual(parseLsof(""), []);
});

test("pidStart is stable for a live process and undefined for a dead one", async () => {
  const a = await pidStart(process.pid);
  assert.ok(a);
  assert.equal(await pidStart(process.pid), a);
  const child = sleeper();
  await settle();
  const b = await pidStart(child.pid!);
  assert.ok(b);
  child.kill("SIGKILL");
  await gone(child.pid!);
  assert.equal(await pidStart(child.pid!), undefined);
});

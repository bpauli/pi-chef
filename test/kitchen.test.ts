import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { ChefError, type Notice, type Pid, type SessionId, type TaskId, millis, parseProjectName, runNo } from "../extension/domain.ts";
import { alive, runsSession, scanCooks, signalCook } from "../extension/cooks.ts";
import { boardHeader } from "../extension/derive.ts";
import { Kitchen, type KitchenDeps, KitchenReader, type Opened } from "../extension/kitchen.ts";
import { PRINCIPLES_DIR, RULES } from "../extension/principles.ts";
import { RunTails, Store } from "../extension/store.ts";
import { CHEF_ENTRY, COMMIT_STEP, FAKE_MODEL, FAKE_PROVIDER, NEVER_EXIT, PI_CLI, REPORT_STEP, ROLE_RECORDER, SLOW_EXIT, type TempKitchen, git, makeRepo, startFakeModel, tempKitchen, until } from "./support.ts";

let fake: Awaited<ReturnType<typeof startFakeModel>>;
let tk: TempKitchen;
before(async () => {
  fake = await startFakeModel();
});
after(() => fake.stop());
afterEach(async () => {
  await reapCooks(new Store(tk.kitchenDir));
  tk.dispose();
});

async function reapCooks(store: Store): Promise<void> {
  const cooks = await scanCooks();
  for (const rec of store.snapshot(new RunTails(), new Set()).records) {
    const pid = cooks.get(rec.spec.sessionId);
    if (pid) await signalCook(pid, rec.spec.sessionId, "SIGKILL");
  }
}

const self = (sessionId = "chef-test") => ({ pid: process.pid as Pid, sessionId });
const pi = { command: process.execPath, args: [PI_CLI] };

async function openOwner(sessionId = "chef-test", takeover = false, deps: Partial<KitchenDeps> = {}): Promise<Kitchen> {
  const opened = await Kitchen.open({ store: new Store(tk.kitchenDir), pi, chefEntry: CHEF_ENTRY, self: self(sessionId), killGraceMs: 2000, ...deps }, { takeover });
  assert.equal(opened.kind, "owner");
  return (opened as Extract<Opened, { kind: "owner" }>).kitchen;
}

async function setup(config: Record<string, unknown> = {}, deps: Partial<KitchenDeps> = {}): Promise<{ kitchen: Kitchen; store: Store; repos: { api: string; web: string } }> {
  tk = tempKitchen(config);
  const repos = { api: makeRepo(tk.home, "api"), web: makeRepo(tk.home, "web") };
  const kitchen = await openOwner("chef-test", false, deps);
  await kitchen.addProject({ path: repos.api, note: "api service" });
  await kitchen.addProject({ path: join(repos.web, "."), name: "web" });
  return { kitchen, store: new Store(tk.kitchenDir), repos };
}

async function waitNotice(kitchen: Kitchen, task: string, timeoutMs = 40_000): Promise<Notice> {
  const notice = await until(`notice for ${task}`, async () => {
    const report = await kitchen.tick();
    assert.equal(report.kind, "ok");
    if (report.kind === "ok" && report.errors.length) throw new Error(report.errors.join("; "));
    return report.kind === "ok" ? report.notices.find((n) => n.task === task) : undefined;
  }, timeoutMs);
  await kitchen.markNotified([notice]);
  return notice;
}

async function waitState(kitchen: Kitchen, task: string, kind: string, timeoutMs = 30_000) {
  return until(`${task} ${kind}`, async () => {
    const report = await kitchen.tick();
    if (report.kind !== "ok") return undefined;
    const view = report.board.open.find((v) => v.spec.id === task);
    return view?.state.kind === kind ? view : undefined;
  }, timeoutMs);
}

const runFiles = (store: Store, task: string) => readdirSync(join(store.taskDir(task as TaskId), "runs")).sort();

test("addProject without a name slugifies the repository directory name", async () => {
  tk = tempKitchen();
  const kitchen = await openOwner();
  const project = await kitchen.addProject({ path: makeRepo(tk.home, "My.Project_x") });
  assert.equal(project.name, "my-project-x");
  await assert.rejects(kitchen.addProject({ path: makeRepo(tk.home, "My Repo"), name: "My Repo" }), ChefError);
});

test("dispatch to two projects: each cook commits and reports done, one notice per task, and the result shows one unlanded commit", async () => {
  const { kitchen, store, repos } = await setup();
  const brief = (f: string) => `Intent: add ${f}.\n${COMMIT_STEP(f)}\n${REPORT_STEP("done", `added ${f}`)}`;
  const a = await kitchen.dispatch({ project: "api", title: "Add a", brief: brief("a.txt") });
  const w = await kitchen.dispatch({ project: "web", title: "Add w", brief: brief("w.txt") });
  assert.equal(a.spec.id, "api-1");
  assert.equal(w.spec.id, "web-1");
  assert.equal(a.state.kind, "cooking");
  assert.ok(existsSync(store.runFile(a.spec.id, runNo(1))));

  const na = await waitNotice(kitchen, "api-1");
  const nw = await waitNotice(kitchen, "web-1");
  assert.deepEqual(na.outcome, { kind: "done", summary: "added a.txt", reported: true });
  assert.deepEqual(nw.outcome, { kind: "done", summary: "added w.txt", reported: true });

  const result = await kitchen.result(a.spec.id);
  assert.equal(result.view.state.kind, "idle");
  assert.deepEqual(result.git, { dirtyFiles: 0, ahead: 1, unlanded: 1, onBranch: true });
  assert.match(result.diffstat, /a\.txt/);
  assert.equal(result.transcript, store.runFile(a.spec.id, runNo(1)));
  assert.equal(git(repos.api, "rev-list", "--count", "main..chef/api-1"), "1");

  const quiet = await kitchen.tick();
  assert.equal(quiet.kind, "ok");
  assert.deepEqual(quiet.kind === "ok" && quiet.notices, []);
  assert.deepEqual(runFiles(store, "api-1"), ["1.err", "1.jsonl", "1.prompt.md"]);
  assert.equal(quiet.kind === "ok" && quiet.board.cooks.busy, 0);
});

test("needs_decision wakes with the question; chef_send relaunches run 2 on the same session and the cook commits and reports done", async () => {
  const { kitchen, store } = await setup();
  const brief = [REPORT_STEP("needs_decision", "cookie or bearer token?"), COMMIT_STEP("b.txt"), REPORT_STEP("done", "used cookies")].join("\n");
  const view = await kitchen.dispatch({ project: "api", title: "Fix login", brief });
  const n1 = await waitNotice(kitchen, view.spec.id);
  assert.deepEqual(n1.outcome, { kind: "needs_decision", question: "cookie or bearer token?" });
  assert.equal(n1.run, 1);

  const delivery = await kitchen.send(view.spec.id, "use cookies");
  assert.deepEqual(delivery, { kind: "relaunched", run: 2 });
  const n2 = await waitNotice(kitchen, view.spec.id);
  assert.deepEqual(n2.outcome, { kind: "done", summary: "used cookies", reported: true });
  assert.equal(n2.run, 2);

  const run2 = readFileSync(store.runFile(view.spec.id, runNo(2)), "utf8");
  const header = JSON.parse(run2.split("\n")[0]!) as { id: string };
  assert.equal(header.id, view.spec.sessionId);
  assert.match(run2, /Messages from the chef/);
  assert.match(run2, /use cookies/);
  assert.equal(readdirSync(join(store.inboxDir(view.spec.id), "handled")).length, 1);
  assert.deepEqual(store.pendingMessages(view.spec.id), []);
  assert.equal((await kitchen.result(view.spec.id)).git?.ahead, 1);
});

test("send to a cook that reported and is still exiting waits for the exit and reports relaunched, not queued behind the cap", async () => {
  const { kitchen, store } = await setup({ cookArgs: ["-e", FAKE_PROVIDER, "-e", SLOW_EXIT] });
  const brief = [REPORT_STEP("needs_decision", "cookie or bearer token?"), REPORT_STEP("done", "used cookies")].join("\n");
  const view = await kitchen.dispatch({ project: "api", title: "Fix login", brief });
  const n1 = await waitNotice(kitchen, view.spec.id);
  assert.equal(n1.outcome.kind, "needs_decision");
  const oldPid = (await scanCooks()).get(view.spec.sessionId);
  assert.ok(oldPid !== undefined, "the reported cook is still exiting when send is called");

  const delivery = await kitchen.send(view.spec.id, "use cookies");
  assert.deepEqual(delivery, { kind: "relaunched", run: 2 });
  assert.equal(await runsSession(oldPid, view.spec.sessionId), false, "run 2 started only after the old cook exited");
  const n2 = await waitNotice(kitchen, view.spec.id);
  assert.deepEqual(n2.outcome, { kind: "done", summary: "used cookies", reported: true });
  assert.equal(n2.run, 2);
  assert.deepEqual(store.pendingMessages(view.spec.id), []);
});

test("send gives up waiting for a slow exit after exitWaitMs and reports after-exit, and the tick relaunches once the cook is gone", async () => {
  const { kitchen, store } = await setup({ cookArgs: ["-e", FAKE_PROVIDER, "-e", SLOW_EXIT] }, { exitWaitMs: 200 });
  const brief = [REPORT_STEP("needs_decision", "cookie or bearer token?"), REPORT_STEP("done", "used cookies")].join("\n");
  const view = await kitchen.dispatch({ project: "api", title: "Fix login", brief });
  await waitNotice(kitchen, view.spec.id);

  const delivery = await kitchen.send(view.spec.id, "use cookies");
  assert.deepEqual(delivery, { kind: "after-exit" });
  assert.equal(existsSync(store.runFile(view.spec.id, runNo(2))), false);
  const n2 = await waitNotice(kitchen, view.spec.id);
  assert.deepEqual(n2.outcome, { kind: "done", summary: "used cookies", reported: true });
  assert.equal(n2.run, 2);
});

test("a message sent while the cook runs is steered into the same run and no second run starts", async () => {
  const { kitchen, store } = await setup();
  const view = await kitchen.dispatch({ project: "api", title: "Listen", brief: "STEP bash: sleep 4\nSTEP echo-users:" });
  await until("cook is inside bash", async () => {
    const v = await waitState(kitchen, view.spec.id, "cooking", 5000);
    return v.state.kind === "cooking" && v.state.activity.kind === "tool" ? v : undefined;
  });
  const delivery = await kitchen.send(view.spec.id, "hello cook");
  assert.deepEqual(delivery, { kind: "steer" });
  const notice = await waitNotice(kitchen, view.spec.id);
  assert.equal(notice.outcome.kind, "done");
  assert.ok(notice.outcome.kind === "done" && !notice.outcome.reported);
  assert.match(notice.outcome.kind === "done" ? notice.outcome.summary : "", /hello cook/);
  assert.deepEqual(runFiles(store, view.spec.id), ["1.err", "1.jsonl", "1.prompt.md"]);
  assert.equal(readdirSync(join(store.inboxDir(view.spec.id), "handled")).length, 1);
});

test("the cook's model receives the cook contract in its system prompt", async () => {
  const { kitchen } = await setup();
  const view = await kitchen.dispatch({ project: "api", title: "Who am I", brief: "STEP echo-system:" });
  const notice = await waitNotice(kitchen, view.spec.id);
  assert.equal(notice.outcome.kind, "done");
  const summary = notice.outcome.kind === "done" ? notice.outcome.summary : "";
  assert.match(summary, /You are a cook in chef's kitchen: a Pi agent that works alone on task api-1 "Who am I"/);
  assert.match(summary, /End every run with exactly one chef_report call/);
  assert.match(summary, /chef_report/);
});

test("the cook's model receives the cook principles, with an index of the vendored files, and none of the chef rules", async () => {
  const { kitchen } = await setup();
  const view = await kitchen.dispatch({ project: "api", title: "Principles", brief: "STEP echo-system:" });
  const notice = await waitNotice(kitchen, view.spec.id);
  const prompt = notice.outcome.kind === "done" ? notice.outcome.summary : "";
  for (const rule of RULES.cook) assert.ok(prompt.includes(rule.text), `cook rule present: ${rule.text}`);
  for (const rule of RULES.chef) assert.ok(!prompt.includes(rule.text), `no chef rule: ${rule.text}`);
  assert.ok(prompt.includes(join(PRINCIPLES_DIR, "principle-fix-root-causes", "SKILL.md")), "the index names the vendored files");
});

test("a role request in a cook process gets cook", async () => {
  const { kitchen } = await setup({ cookArgs: ["-e", FAKE_PROVIDER, "-e", ROLE_RECORDER] });
  const record = join(tk.home, "roles.txt");
  process.env.ROLE_RECORD = record;
  try {
    const view = await kitchen.dispatch({ project: "api", title: "Role", brief: REPORT_STEP("done", "asked") });
    assert.equal((await waitNotice(kitchen, view.spec.id)).outcome.kind, "done");
  } finally {
    delete process.env.ROLE_RECORD;
  }
  assert.deepEqual(readFileSync(record, "utf8").split("\n").filter(Boolean), ["cook"]);
});

test("stop ends a running cook as stopped with no notice, and chef_send resumes it on run 2", async () => {
  const { kitchen, store } = await setup();
  const view = await kitchen.dispatch({ project: "api", title: "Long", brief: `STEP bash: sleep 60\n${REPORT_STEP("done", "resumed")}` });
  await until("cook is inside bash", async () => {
    const v = await waitState(kitchen, view.spec.id, "cooking", 5000);
    return v.state.kind === "cooking" && v.state.activity.kind === "tool" ? v : undefined;
  });
  const pid = (await scanCooks()).get(view.spec.sessionId);
  assert.ok(pid);
  const stopped = (await kitchen.stop(view.spec.id)).view;
  const idle = stopped.state.kind === "idle" ? stopped : await waitState(kitchen, view.spec.id, "idle");
  assert.deepEqual(idle.state.kind === "idle" && idle.state.outcome, { kind: "stopped" });
  await until("cook process exit", () => (alive(pid) ? undefined : true));
  const quiet = await kitchen.tick();
  assert.deepEqual(quiet.kind === "ok" && quiet.notices, []);
  assert.deepEqual(store.readEvents(view.spec.id).map((e) => e.type), ["stop"]);

  assert.deepEqual(await kitchen.send(view.spec.id, "go on"), { kind: "relaunched", run: 2 });
  const notice = await waitNotice(kitchen, view.spec.id);
  assert.deepEqual(notice.outcome, { kind: "done", summary: "resumed", reported: true });
});

test("a message sent right after a stop is not read by the dying cook and restarts the task on run 2", async () => {
  const { kitchen, store } = await setup();
  const view = await kitchen.dispatch({ project: "api", title: "Long", brief: `STEP bash: sleep 60\n${REPORT_STEP("done", "resumed")}` });
  await until("cook is inside bash", async () => {
    const v = await waitState(kitchen, view.spec.id, "cooking", 5000);
    return v.state.kind === "cooking" && v.state.activity.kind === "tool" ? v : undefined;
  });
  await kitchen.stop(view.spec.id);
  const delivery = await kitchen.send(view.spec.id, "carry on");
  assert.ok(delivery.kind === "after-stop" || delivery.kind === "relaunched", `got ${delivery.kind}`);
  const whereIsTheMessage = () => {
    const inbox = store.inboxDir(view.spec.id);
    const run1 = readFileSync(store.runFile(view.spec.id, runNo(1)), "utf8");
    return `pending=${JSON.stringify(readdirSync(inbox).filter((f) => f.endsWith(".msg")))} handled=${JSON.stringify(readdirSync(join(inbox, "handled")))} runs=${JSON.stringify(runFiles(store, view.spec.id))} run1 has message=${run1.includes("carry on")} events=${JSON.stringify(store.readEvents(view.spec.id))}`;
  };
  const notice = await waitNotice(kitchen, view.spec.id, 20_000).catch((e: Error) => {
    throw new Error(`${e.message}; ${whereIsTheMessage()}`);
  });
  assert.equal(notice.run, 2);
  assert.deepEqual(notice.outcome, { kind: "done", summary: "resumed", reported: true });
  assert.match(store.readPrompt(view.spec.id, runNo(2)) ?? "", /carry on/, "the owner, not the dying cook, took the message");
  assert.deepEqual(store.readEvents(view.spec.id).map((e) => e.type), ["stop", "notified"]);
});

test("close refuses unlanded work, then succeeds after a merge and removes the worktree and branch", async () => {
  const { kitchen, store, repos } = await setup();
  const view = await kitchen.dispatch({ project: "api", title: "Add c", brief: `${COMMIT_STEP("c.txt")}\n${REPORT_STEP("done", "added c")}` });
  await waitNotice(kitchen, view.spec.id);
  await assert.rejects(kitchen.close(view.spec.id, false), (e: unknown) => e instanceof ChefError && /1 commit not on the base branch/.test(e.message));
  assert.ok(existsSync(view.spec.worktree));

  git(repos.api, "merge", "-q", "--ff-only", "chef/api-1");
  const closed = await kitchen.close(view.spec.id, false);
  assert.equal(closed.view.state.kind, "closed");
  assert.deepEqual(closed.removal, { worktree: "removed", branch: "deleted" });
  assert.equal(existsSync(view.spec.worktree), false);
  assert.equal(git(repos.api, "branch", "--list", "chef/api-1"), "");
  assert.deepEqual(store.readEvents(view.spec.id).map((e) => e.type), ["notified", "closed"]);
  const again = await kitchen.close(view.spec.id, false);
  assert.equal(again.view.state.kind, "closed");
  assert.deepEqual(again.removal, { worktree: "missing", branch: "missing" });
  const board = await kitchen.tick();
  assert.equal(board.kind === "ok" && board.board.open.length, 0);
  assert.equal(board.kind === "ok" && board.board.closedCount, 1);
});

test("close with discard stops a running cook and removes its worktree and branch", async () => {
  const { kitchen, repos } = await setup();
  const view = await kitchen.dispatch({ project: "api", title: "Drop me", brief: `${COMMIT_STEP("d.txt")}\nSTEP bash: sleep 60` });
  await until("cook has committed", async () => {
    await kitchen.tick();
    return git(repos.api, "branch", "--list", "chef/api-1") && git(repos.api, "rev-list", "--count", "main..chef/api-1") === "1" ? true : undefined;
  });
  await assert.rejects(kitchen.close(view.spec.id, false), /still cooking/);
  const closed = await kitchen.close(view.spec.id, true);
  assert.equal(closed.view.state.kind, "closed");
  await until("worktree removed", async () => {
    await kitchen.tick();
    return existsSync(view.spec.worktree) ? undefined : true;
  });
  assert.equal(git(repos.api, "branch", "--list", "chef/api-1"), "");
});

test("a new Kitchen adopts a live cook without a second launch and wakes once when it finishes", async () => {
  const { kitchen: first, store } = await setup();
  const view = await first.dispatch({ project: "api", title: "Slow", brief: `STEP bash: sleep 5\n${REPORT_STEP("done", "slept")}` });
  await until("cook is inside bash", async () => {
    const v = await waitState(first, view.spec.id, "cooking", 5000);
    return v.state.kind === "cooking" && v.state.activity.kind === "tool" ? v : undefined;
  });
  first.release();
  assert.equal(existsSync(store.lockFile()), false);

  const second = await openOwner("chef-second");
  const report = await second.tick();
  assert.equal(report.kind, "ok");
  const adopted = report.kind === "ok" ? report.board.open[0]! : undefined;
  assert.equal(adopted?.state.kind, "cooking");
  assert.equal(adopted?.state.kind === "cooking" && adopted.state.run, 1);
  assert.deepEqual(runFiles(store, view.spec.id), ["1.err", "1.jsonl", "1.prompt.md"]);

  const notice = await waitNotice(second, view.spec.id);
  assert.deepEqual(notice.outcome, { kind: "done", summary: "slept", reported: true });
  assert.deepEqual(runFiles(store, view.spec.id), ["1.err", "1.jsonl", "1.prompt.md"]);
  assert.deepEqual(store.readEvents(view.spec.id).map((e) => e.type), ["notified"]);
});

test("a cook that finished while no owner ran is reported by the next owner's first tick, and the second tick adds nothing", async () => {
  const { kitchen: first, store } = await setup();
  const view = await first.dispatch({ project: "api", title: "Quick", brief: `${COMMIT_STEP("q.txt")}\n${REPORT_STEP("done", "quick")}` });
  first.release();
  await until("cook settles on its own", () => (readFileSync(store.runFile(view.spec.id, runNo(1)), "utf8").includes('"agent_settled"') ? true : undefined));
  await until("cook process exit", async () => ((await scanCooks()).has(view.spec.sessionId) ? undefined : true));

  const second = await openOwner("chef-second");
  const first_tick = await second.tick();
  assert.equal(first_tick.kind, "ok");
  assert.deepEqual(first_tick.kind === "ok" && first_tick.notices.map((n) => [n.task, n.outcome]), [[view.spec.id, { kind: "done", summary: "quick", reported: true }]]);
  assert.deepEqual(first_tick.kind === "ok" && first_tick.errors, []);
  await second.markNotified(first_tick.kind === "ok" ? first_tick.notices : []);
  const second_tick = await second.tick();
  assert.deepEqual(second_tick.kind === "ok" && second_tick.notices, []);
  assert.deepEqual(runFiles(store, view.spec.id), ["1.err", "1.jsonl", "1.prompt.md"]);
  assert.equal(second_tick.kind === "ok" && second_tick.board.cooks.busy, 0);
});

test("maxCooks 1: the second task queues and starts after the first finishes", async () => {
  const { kitchen, store } = await setup({ maxCooks: 1 });
  const t1 = await kitchen.dispatch({ project: "api", title: "First", brief: `STEP bash: sleep 3\n${REPORT_STEP("done", "first")}` });
  const t2 = await kitchen.dispatch({ project: "web", title: "Second", brief: REPORT_STEP("done", "second") });
  assert.equal(t1.state.kind, "cooking");
  assert.deepEqual(t2.state, { kind: "queued", why: "new" });
  assert.equal(existsSync(store.runFile(t2.spec.id, runNo(1))), false);
  const n1 = await waitNotice(kitchen, t1.spec.id);
  assert.equal(n1.outcome.kind, "done");
  const n2 = await waitNotice(kitchen, t2.spec.id);
  assert.deepEqual(n2.outcome, { kind: "done", summary: "second", reported: true });
});

test("a held queued task that chef_send resumes runs to its report and is not stopped when its cook starts", async () => {
  const { kitchen, store } = await setup({ maxCooks: 1 });
  const t1 = await kitchen.dispatch({ project: "api", title: "First", brief: `STEP bash: sleep 3\n${REPORT_STEP("done", "first")}` });
  const t2 = await kitchen.dispatch({ project: "web", title: "Second", brief: REPORT_STEP("done", "second") });
  assert.deepEqual((await kitchen.stop(t2.spec.id)).view.state, { kind: "idle", run: undefined, since: store.readEvents(t2.spec.id)[0]!.at, outcome: { kind: "stopped" } });
  assert.deepEqual(store.readEvents(t2.spec.id).map((e) => e.type), ["hold"]);
  assert.deepEqual(await kitchen.send(t2.spec.id, "go"), { kind: "queued", position: 1 });
  await waitNotice(kitchen, t1.spec.id);
  const n2 = await waitNotice(kitchen, t2.spec.id);
  assert.deepEqual(n2.outcome, { kind: "done", summary: "second", reported: true });
});

test("a prompt file without a run file is relaunched from that prompt (interrupted launch)", async () => {
  const { kitchen, store } = await setup();
  const id = store.nextTaskId(parseProjectName("api"));
  store.createTask({
    id,
    project: parseProjectName("api"),
    title: "Interrupted",
    brief: "unused",
    branch: `chef/${id}`,
    worktree: store.worktreeDir(id),
    baseBranch: "main",
    sessionId: "0199c0de-1111-7000-8000-000000000001" as SessionId,
    model: undefined,
    createdAt: millis(Date.now()),
  });
  const prompt = `handwritten prompt\n${REPORT_STEP("done", "from the old prompt")}\n`;
  store.writePrompt(id, runNo(1), prompt);
  const notice = await waitNotice(kitchen, id);
  assert.deepEqual(notice.outcome, { kind: "done", summary: "from the old prompt", reported: true });
  assert.equal(store.readPrompt(id, runNo(1)), prompt);
  assert.deepEqual(runFiles(store, id), ["1.err", "1.jsonl", "1.prompt.md"]);
});

test("a cook killed with SIGKILL derives failed with the stderr tail", async () => {
  const { kitchen, store } = await setup();
  const view = await kitchen.dispatch({ project: "api", title: "Doomed", brief: "STEP bash: sleep 60" });
  await until("cook is inside bash", async () => {
    const v = await waitState(kitchen, view.spec.id, "cooking", 5000);
    return v.state.kind === "cooking" && v.state.activity.kind === "tool" ? v : undefined;
  });
  const pid = (await scanCooks()).get(view.spec.sessionId)!;
  writeFileSync(store.runErr(view.spec.id, runNo(1)), "fatal: out of memory\n", { flag: "a" });
  process.kill(-pid, "SIGKILL");
  const notice = await waitNotice(kitchen, view.spec.id);
  assert.equal(notice.outcome.kind, "failed");
  assert.match(notice.outcome.kind === "failed" ? notice.outcome.reason : "", /^cook exited before settling: .*fatal: out of memory$/);
});

test("a cook that exits before its first output line is a failed launch with the stderr tail, not an endless relaunch, and a send retries it with the brief", async () => {
  const { kitchen, store } = await setup({ model: "nope/none" });
  const view = await kitchen.dispatch({ project: "api", title: "Add a", brief: `${COMMIT_STEP("a.txt")}\n${REPORT_STEP("done", "added a.txt")}` });
  await until("cook exit", async () => ((await scanCooks()).has(view.spec.sessionId) ? undefined : true));
  const report = await kitchen.tick();
  const state = report.kind === "ok" ? report.board.open[0]!.state : undefined;
  assert.deepEqual({ kind: state?.kind, outcome: state?.kind === "idle" ? state.outcome.kind : undefined }, { kind: "idle", outcome: "failed" });
  const notice = await waitNotice(kitchen, view.spec.id, 10_000);
  assert.equal(notice.run, 1);
  assert.match(notice.outcome.kind === "failed" ? notice.outcome.reason : "", /before its first output line: .*Model "nope\/none" not found/);
  await kitchen.tick();
  assert.equal(store.runBytes(view.spec.id, runNo(1)), 0);
  assert.equal(readFileSync(store.runErr(view.spec.id, runNo(1)), "utf8").match(/not found/g)?.length, 1, "one attempt, its diagnostic kept");
  assert.deepEqual(runFiles(store, view.spec.id), ["1.err", "1.jsonl", "1.prompt.md"]);

  writeFileSync(join(tk.kitchenDir, "config.json"), JSON.stringify({ model: FAKE_MODEL, cookArgs: ["-e", FAKE_PROVIDER] }));
  assert.deepEqual(await kitchen.send(view.spec.id, "retry"), { kind: "relaunched", run: 2 });
  const done = await waitNotice(kitchen, view.spec.id);
  assert.deepEqual(done.outcome, { kind: "done", summary: "added a.txt", reported: true });
  const run2 = readFileSync(store.runFile(view.spec.id, runNo(2)), "utf8");
  assert.match(run2, /# Add a/, "the brief travels with the retry since run 1 never delivered it");
  assert.match(run2, /retry/);
  assert.deepEqual(store.readEvents(view.spec.id).map((e) => e.type).sort(), ["launch_failed", "notified", "notified"]);
});

test("a dispatch whose worktree cannot be created fails at once with the git error and is not retried every tick", async () => {
  const { kitchen, store } = await setup();
  writeFileSync(store.worktreeDir("api-1" as TaskId), "a file where the worktree should go");
  const view = await kitchen.dispatch({ project: "api", title: "Doomed", brief: "STEP say: hi" });
  assert.equal(view.state.kind, "idle");
  assert.match(view.state.kind === "idle" && view.state.outcome.kind === "failed" ? view.state.outcome.reason : "", /not a directory/);
  const notice = await waitNotice(kitchen, view.spec.id, 5000);
  assert.equal(notice.outcome.kind, "failed");
  const quiet = await kitchen.tick();
  assert.deepEqual(quiet.kind === "ok" && quiet.errors, []);
  assert.equal(existsSync(join(store.taskDir(view.spec.id), "runs")) && readdirSync(join(store.taskDir(view.spec.id), "runs")).length, 0);
  assert.deepEqual(store.readEvents(view.spec.id).map((e) => e.type), ["launch_failed", "notified"]);
});

test("addProject refuses a base branch that does not exist or starts with a dash, and dispatch refuses a blank model and stores a trimmed one", async () => {
  const { kitchen, store, repos } = await setup();
  await assert.rejects(kitchen.addProject({ path: repos.api, name: "nope", baseBranch: "no-such-branch" }), (e: unknown) => e instanceof ChefError && /no-such-branch/.test(e.message));
  await assert.rejects(kitchen.addProject({ path: repos.api, name: "dash", baseBranch: "--output=/tmp/x" }), ChefError);
  assert.deepEqual(store.loadProjects().projects.map((p) => p.name), ["api", "web"]);
  await assert.rejects(kitchen.dispatch({ project: "api", title: "x", brief: "y", model: "  " }), (e: unknown) => e instanceof ChefError && /model/.test(e.message));
  assert.deepEqual(store.listTaskIds(), []);
  const padded = await kitchen.dispatch({ project: "api", title: "m", brief: REPORT_STEP("done", "m"), model: ` ${FAKE_MODEL} ` });
  assert.equal(store.readSpec(padded.spec.id).model, FAKE_MODEL);
  git(repos.api, "branch", "release");
  const p = await kitchen.addProject({ path: repos.api, name: "rel", baseBranch: "release" });
  assert.equal(p.baseBranch, "release");
});

test("a broken task.json or config.json does not stop the tick: the broken task is listed, the config falls back, and healthy tasks run", async () => {
  const { kitchen, store } = await setup();
  const badTask = "api-9" as TaskId;
  mkdirSync(join(store.taskDir(badTask), "runs"), { recursive: true });
  writeFileSync(join(store.taskDir(badTask), "task.json"), "{ not json");
  const goodConfig = JSON.stringify({ model: FAKE_MODEL, cookArgs: ["-e", FAKE_PROVIDER] });
  writeFileSync(join(tk.kitchenDir, "config.json"), '{"maxCooks": "three"}');
  const report = await kitchen.tick().catch((e: Error) => e);
  assert.equal(report instanceof Error ? report.message : report.kind, "ok");
  if (report instanceof Error || report.kind !== "ok") return;
  assert.deepEqual(report.board.broken.map((b) => b.id), [badTask]);
  assert.match(report.board.broken[0]!.reason, /not valid JSON/);
  assert.equal(report.board.cooks.cap, 3, "a bad config falls back to the defaults");
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0]!, /config\.json.*maxCooks/);

  writeFileSync(join(tk.kitchenDir, "config.json"), goodConfig);
  const view = await kitchen.dispatch({ project: "api", title: "Healthy", brief: REPORT_STEP("done", "ok") });
  assert.equal(view.state.kind, "cooking");
  const notice = await waitNotice(kitchen, view.spec.id);
  assert.deepEqual(notice.outcome, { kind: "done", summary: "ok", reported: true });
  const quiet = await kitchen.tick();
  assert.deepEqual(quiet.kind === "ok" && quiet.errors, []);
  assert.deepEqual(quiet.kind === "ok" && quiet.board.broken.map((b) => b.id), [badTask]);
  assert.deepEqual(quiet.kind === "ok" && quiet.board.open.map((v) => v.spec.id), [view.spec.id]);
});

test("a cook that never exits after its report is signalled and killed by the tick, and the task can be sent to again", async () => {
  const { kitchen, store } = await setup({ cookArgs: ["-e", FAKE_PROVIDER, "-e", NEVER_EXIT] }, { exitGraceMs: 500, killGraceMs: 1000 });
  const brief = [REPORT_STEP("needs_decision", "cookie or bearer token?"), REPORT_STEP("done", "used cookies")].join("\n");
  const view = await kitchen.dispatch({ project: "api", title: "Stuck", brief });
  const n1 = await waitNotice(kitchen, view.spec.id);
  assert.equal(n1.outcome.kind, "needs_decision");
  const pid = (await scanCooks()).get(view.spec.sessionId);
  assert.ok(pid !== undefined, "the reported cook is still alive");
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await kitchen.tick();
    await new Promise((ok) => setTimeout(ok, 200));
  }
  assert.equal(alive(pid), false, "the tick escalated SIGTERM to SIGKILL for the stuck cook");
  assert.deepEqual(await kitchen.send(view.spec.id, "use cookies"), { kind: "relaunched", run: 2 });
  const n2 = await waitNotice(kitchen, view.spec.id);
  assert.deepEqual(n2.outcome, { kind: "done", summary: "used cookies", reported: true });
  await until("run 2 exit, forced by the tick as well", async () => {
    await kitchen.tick();
    return (await scanCooks()).has(view.spec.sessionId) ? undefined : true;
  }, 10_000);
  assert.deepEqual(store.readEvents(view.spec.id).map((e) => e.type), ["notified", "notified"]);
});

test("a launch rescans for a cook the owner does not know, so a liveness miss never starts a second cook on the session", async () => {
  const { kitchen, store } = await setup();
  const id = store.nextTaskId(parseProjectName("api"));
  const sid = `0199c0de-3333-7000-8000-${String(process.pid).padStart(12, "0")}` as SessionId;
  store.createTask({ id, project: parseProjectName("api"), title: "Ghost", brief: "unused", branch: `chef/${id}`, worktree: store.worktreeDir(id), baseBranch: "main", sessionId: sid, model: undefined, createdAt: millis(Date.now()) });
  store.writePrompt(id, runNo(1), "STEP say: hi\n");
  const claim = store.claimRun(id, runNo(1));
  assert.ok(claim.kind === "claimed");
  const { fds } = claim;
  writeFileSync(store.runFile(id, runNo(1)), `${JSON.stringify({ type: "turn_start" })}\n`);
  for (const fd of [fds.stdout, fds.stderr]) closeSync(fd);
  const first = await waitNotice(kitchen, id);
  assert.equal(first.outcome.kind, "failed", "no process anywhere: the run is dead");

  const ghost = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", env: { ...process.env, CHEF_SESSION_ID: sid } });
  ghost.unref();
  await until("ghost cook", async () => ((await scanCooks()).get(sid) === ghost.pid ? true : undefined));
  try {
    const delivery = await kitchen.send(id, "go on");
    assert.equal(existsSync(store.runFile(id, runNo(2))), false, "no second cook while one runs on the session");
    assert.deepEqual(delivery, { kind: "steer" });
  } finally {
    ghost.kill("SIGKILL");
  }
  await until("ghost exit", () => (alive(ghost.pid!) ? undefined : true));
  const resumed = await waitNotice(kitchen, id);
  assert.equal(resumed.run, 2);
  assert.equal(resumed.outcome.kind, "done");
});

test("a second session opens read-only and cannot dispatch; takeover moves the lease and the old owner loses it", async () => {
  const { kitchen } = await setup();
  const other = await Kitchen.open({ store: new Store(tk.kitchenDir), pi, chefEntry: CHEF_ENTRY, self: self("chef-other") });
  assert.equal(other.kind, "read-only");
  if (other.kind !== "read-only") return;
  assert.equal(other.holder.pid, process.pid);
  assert.equal(other.holder.sessionId, "chef-test");
  assert.ok(other.reader instanceof KitchenReader && !(other.reader instanceof Kitchen));
  assert.equal(!("dispatch" in other.reader), true);
  const board = await other.reader.board();
  assert.equal(board.role, "read-only");
  assert.equal(board.projects.length, 2);
  assert.equal((await kitchen.tick()).kind, "ok");

  const taken = await openOwner("chef-other", true);
  assert.equal((await taken.tick()).kind, "ok");
  const lost = await kitchen.tick();
  assert.equal(lost.kind, "lost");
  assert.equal(lost.kind === "lost" && lost.holder?.sessionId, "chef-other");
  await assert.rejects(kitchen.dispatch({ project: "api", title: "x", brief: "y" }), /takeover/);
});

test("the owner's board says owner and its header does not claim read-only", async () => {
  const { kitchen } = await setup();
  const board = await kitchen.board();
  assert.equal(board.role, "owner");
  assert.doesNotMatch(boardHeader(board), /read-only/);
});

test("a read-only session promotes itself once the lease is free, and not while another owner holds it", async () => {
  const { kitchen } = await setup();
  const other = await Kitchen.open({ store: new Store(tk.kitchenDir), pi, chefEntry: CHEF_ENTRY, self: self("chef-other") });
  assert.equal(other.kind, "read-only");
  if (other.kind !== "read-only") return;
  assert.equal(await other.reader.promote(), undefined, "the owner is alive, so the reader stays read-only");
  kitchen.release();
  const promoted = await other.reader.promote();
  assert.ok(promoted instanceof Kitchen);
  assert.equal((await promoted.tick()).kind, "ok");
  assert.equal(new Store(tk.kitchenDir).readLease()?.sessionId, "chef-other");
  assert.equal((await kitchen.tick()).kind, "lost");
});

test("a stale lease from a dead pid or a reused pid is replaced", async () => {
  tk = tempKitchen();
  const store = new Store(tk.kitchenDir);
  store.ensureLayout();
  store.writeLease({ pid: 2_000_000, pidStart: "x", sessionId: "dead", since: 1 });
  const first = await Kitchen.open({ store, pi, chefEntry: CHEF_ENTRY, self: self("new") });
  assert.equal(first.kind, "owner");
  store.writeLease({ pid: process.pid, pidStart: "not-our-start", sessionId: "reused", since: 1 });
  const second = await Kitchen.open({ store, pi, chefEntry: CHEF_ENTRY, self: self("newer") });
  assert.equal(second.kind, "owner");
  assert.equal(store.readLease()?.sessionId, "newer");
  mkdirSync(join(tk.home, "unused"));
});

test("after a takeover the old owner's send, stop, dispatch, and addProject are refused before they write anything", async () => {
  const { kitchen, store, repos } = await setup();
  const view = await kitchen.dispatch({ project: "api", title: "Long", brief: "STEP bash: sleep 60" });
  await openOwner("chef-other", true);
  await assert.rejects(kitchen.send(view.spec.id, "x"), /takeover/);
  assert.deepEqual(store.pendingMessages(view.spec.id), []);
  await assert.rejects(kitchen.stop(view.spec.id), /takeover/);
  assert.deepEqual(store.readEvents(view.spec.id), []);
  await assert.rejects(kitchen.dispatch({ project: "api", title: "x", brief: "y" }), /takeover/);
  assert.deepEqual(store.listTaskIds(), [view.spec.id]);
  await assert.rejects(kitchen.addProject({ path: repos.web, name: "web2" }), /takeover/);
  assert.equal(store.readProject(parseProjectName("web2")), undefined);
});

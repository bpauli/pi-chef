import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { after, afterEach, before, test } from "node:test";
import { TICK_MS, WAKE_TIMING } from "../extension/chef.ts";
import { scanCooks, signalCook } from "../extension/cooks.ts";
import { PRINCIPLES_DIR, RULES } from "../addons/principles/principles.ts";
import { Store } from "../extension/store.ts";
import type { CooksSnapshot } from "../extension/events.ts";
import { CHEF_ENTRY, COMMIT_STEP, COOKS_RECORDER, PRINCIPLES_ADDON, ROLE_RECORDER, FAKE_HERDR, HERDR_ADDON, SUBAGENTS_ADDON, installFakeSubagents, FAKE_MODEL, FAKE_PROVIDER, PI_CLI, REPORT_STEP, ROOT, type TempKitchen, makeRepo, startFakeModel, tempKitchen, until } from "./support.ts";

let fake: Awaited<ReturnType<typeof startFakeModel>>;
let tk: TempKitchen;
const children: ChildProcess[] = [];
before(async () => {
  fake = await startFakeModel();
});
after(() => fake.stop());
afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  const store = new Store(tk.kitchenDir);
  const cooks = await scanCooks();
  for (const id of store.listTaskIds()) {
    const sid = store.readSpec(id).sessionId;
    const pid = cooks.get(sid);
    if (pid) await signalCook(pid, sid, "SIGKILL");
  }
  tk.dispose();
});

interface Event {
  type: string;
  id?: string;
  message?: { role: string; customType?: string; content?: unknown };
  toolName?: string;
  result?: { content?: { type: string; text?: string }[] };
}

function startPi(mode: "json" | "rpc", extra: string[], prompt?: string, env: NodeJS.ProcessEnv = {}): { proc: ChildProcess; events: Event[]; exited: Promise<number | null> } {
  const args = ["--mode", mode, "--no-session", "-ne", "-e", CHEF_ENTRY, "-e", FAKE_PROVIDER, "--model", FAKE_MODEL, ...extra];
  if (mode === "json") args.push("-p", prompt ?? "STEP say: hi");
  const bin = process.env.CHEF_TEST_PI;
  const proc = bin
    ? spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } })
    : spawn(process.execPath, [PI_CLI, ...args], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } });
  children.push(proc);
  const events: Event[] = [];
  const decoder = new StringDecoder("utf8");
  let partial = "";
  proc.stdout!.on("data", (chunk: Buffer) => {
    const lines = (partial + decoder.write(chunk)).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as Event);
      } catch {}
    }
  });
  const exited = new Promise<number | null>((ok) => proc.on("exit", (code) => ok(code)));
  return { proc, events, exited };
}

const toolsSection = (events: Event[]): string => {
  const system = events.find((e) => e.type === "message_start" && e.message?.role === "system");
  return JSON.stringify(system?.message ?? {});
};

test("chef tools are absent from a plain session and active with --chef", async () => {
  tk = tempKitchen();
  const plain = startPi("json", []);
  plain.proc.stdin!.end();
  assert.equal(await plain.exited, 0);
  assert.doesNotMatch(toolsSection(plain.events), /chef_dispatch/);
  assert.equal(existsSync(join(tk.kitchenDir, "tasks")), false, "a plain session never touches the kitchen");

  const chef = startPi("json", ["--chef"]);
  chef.proc.stdin!.end();
  assert.equal(await chef.exited, 0);
  assert.match(toolsSection(chef.events), /chef_dispatch/);
  assert.match(toolsSection(chef.events), /Never poll cooks/);
  assert.ok(existsSync(join(tk.kitchenDir, "tasks")), "chef mode opened the kitchen");
  assert.equal(existsSync(join(tk.kitchenDir, "pass.lock")), false, "the lease is released at shutdown");
});

const lastAssistantText = (events: Event[]): string => {
  const end = events.filter((e) => e.type === "message_end" && e.message?.role === "assistant").at(-1);
  const content = (end?.message?.content ?? []) as { type: string; text?: string }[];
  return content.map((c) => c.text ?? "").join("");
};

const PRINCIPLE_PATH = join(PRINCIPLES_DIR, "principle-prove-it-works", "SKILL.md");

function assertChefPrinciples(prompt: string, on: boolean, when: string): void {
  for (const rule of RULES.cook) assert.ok(!prompt.includes(rule.text), `${when}: no cook rule in the chef's prompt: ${rule.text}`);
  if (on) {
    for (const rule of RULES.chef) assert.ok(prompt.includes(rule.text), `${when}: chef rule present: ${rule.text}`);
    assert.ok(prompt.includes(PRINCIPLE_PATH), `${when}: the index names the vendored files`);
  } else {
    for (const rule of RULES.chef) assert.ok(!prompt.includes(rule.text), `${when}: no chef rule: ${rule.text}`);
    assert.ok(!prompt.includes(PRINCIPLE_PATH), `${when}: no principle index`);
  }
}

test("with the principles add-on the chef's model gets the chef principles with --chef, and a plain session or a chef without the add-on gets none", async () => {
  tk = tempKitchen();
  const echo = async (extra: string[]) => {
    const run = startPi("json", extra, "STEP echo-system:");
    run.proc.stdin!.end();
    assert.equal(await run.exited, 0);
    return lastAssistantText(run.events);
  };
  assertChefPrinciples(await echo(["-e", PRINCIPLES_ADDON]), false, "plain session with the add-on");
  assertChefPrinciples(await echo(["--chef", "-e", PRINCIPLES_ADDON]), true, "--chef with the add-on");
  assertChefPrinciples(await echo(["--chef"]), false, "--chef without the add-on");
});

test("with the principles add-on the chef principles follow /chef on and /chef off in the same session", async () => {
  tk = tempKitchen();
  const pi = startPi("rpc", ["-e", PRINCIPLES_ADDON]);
  const send = (id: string, message: string) => pi.proc.stdin!.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
  const answered = (id: string) => until(`response ${id}`, () => (pi.events.some((e) => e.type === "response" && e.id === id) ? true : undefined));
  const echoAfter = async (id: string, message: string, settled: number) => {
    send(id, message);
    await until(`settle ${settled}`, () => (settles(pi.events) >= settled ? true : undefined), 30_000);
    return lastAssistantText(pi.events);
  };

  assertChefPrinciples(await echoAfter("p1", "STEP echo-system:\nSTEP echo-system:\nSTEP echo-system:", 1), false, "before /chef");
  send("on", "/chef");
  await answered("on");
  assertChefPrinciples(await echoAfter("p2", "again", 2), true, "after /chef");
  send("off", "/chef off");
  await answered("off");
  assertChefPrinciples(await echoAfter("p3", "again", 3), false, "after /chef off");
  pi.proc.stdin!.end();
  assert.equal(await pi.exited, 0);
});

test("a dispatch leads to exactly one chef-wake that starts a turn, and chef_result reads the landed facts", async () => {
  tk = tempKitchen();
  const repo = makeRepo(tk.home, "api");
  const brief = `Intent: add a.txt.\n${COMMIT_STEP("a.txt")}\n${REPORT_STEP("done", "added a.txt")}`;
  const script = [
    `STEP tool chef_add_project ${JSON.stringify({ path: repo, note: "test repo" })}`,
    `STEP tool chef_dispatch ${JSON.stringify({ project: "api", title: "Add a", brief })}`,
    "STEP say: dispatched",
    `STEP tool chef_result ${JSON.stringify({ task: "api-1" })}`,
    "STEP say: reviewed",
  ].join("\n");
  const chef = startPi("rpc", ["--chef"]);
  chef.proc.stdin!.write(`${JSON.stringify({ id: "p1", type: "prompt", message: script })}\n`);

  const settledTwice = () => chef.events.filter((e) => e.type === "agent_settled").length >= 2;
  await until("the chef's second settle", () => (settledTwice() ? true : undefined), 60_000);
  chef.proc.stdin!.end();
  assert.equal(await chef.exited, 0);

  const toolEnds = chef.events.filter((e) => e.type === "tool_execution_end");
  const text = (name: string) => toolEnds.find((e) => e.toolName === name)?.result?.content?.map((c) => c.text ?? "").join("") ?? "";
  assert.match(text("chef_add_project"), /^Registered api: .*api, tasks fork from main\.$/);
  assert.match(text("chef_dispatch"), /^api-1 is cooking on branch chef\/api-1 \(1\/3 cooks busy\)\. You will get a kitchen update when it needs you\.$/);

  const wakes = chef.events.filter((e) => e.type === "message_start" && e.message?.role === "custom" && e.message.customType === "chef-wake");
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.message!.content, 'Kitchen update (1):\n- api-1 "Add a" is done: added a.txt. Review with chef_result api-1.');
  const wakeAt = chef.events.indexOf(wakes[0]!);
  const firstSettle = chef.events.findIndex((e) => e.type === "agent_settled");
  assert.ok(firstSettle < wakeAt, "the wake arrived after the dispatch turn settled");
  assert.equal(chef.events.slice(firstSettle, wakeAt).some((e) => e.type === "agent_start"), true, "the wake started a new turn");

  const result = text("chef_result");
  assert.match(result, /^api-1 "Add a": idle \d+s, done, run 1\.\nSummary: added a.txt\n/);
  assert.match(result, /Branch chef\/api-1 in .*: 1 commit ahead of main, 1 not landed, clean\./);
  assert.match(result, /a\.txt \| 1 \+/);
  assert.match(result, /Transcript: .*runs\/1\.jsonl$/);

  const store = new Store(tk.kitchenDir);
  assert.deepEqual(store.readEvents("api-1" as never).map((e) => e.type), ["notified"]);
  assert.deepEqual(readdirSync(join(store.taskDir("api-1" as never), "runs")).sort(), ["1.err", "1.jsonl", "1.prompt.md"]);
  const lastText = chef.events.filter((e) => e.type === "message_end" && e.message?.role === "assistant").at(-1);
  assert.equal(JSON.stringify(lastText?.message?.content), JSON.stringify([{ type: "text", text: "reviewed" }]));
});

test("the chef's prompt lists the model rules only in chef mode, and chef_dispatch refuses an unknown rule and skips a model Pi does not know", async () => {
  const rules = [
    { name: "deep", when: "a hard bug", use: [{ model: "fake/unknown" }, { model: FAKE_MODEL, thinking: "low" }], why: "it needs judgment" },
    { name: "docs", when: "docs only", use: { model: FAKE_MODEL } },
  ];
  tk = tempKitchen({ model: undefined, models: { rules, default: { model: FAKE_MODEL } } });
  const plain = startPi("json", [], "STEP echo-system:");
  plain.proc.stdin!.end();
  assert.equal(await plain.exited, 0);
  assert.doesNotMatch(lastAssistantText(plain.events), /Cook models/);

  const repo = makeRepo(tk.home, "api");
  const script = [
    `STEP tool chef_add_project ${JSON.stringify({ path: repo })}`,
    `STEP tool chef_dispatch ${JSON.stringify({ project: "api", title: "Bad rule", brief: "x", rule: "nope" })}`,
    `STEP tool chef_dispatch ${JSON.stringify({ project: "api", title: "Hard bug", brief: REPORT_STEP("done", "fixed"), rule: "deep" })}`,
    "STEP echo-system:",
  ].join("\n");
  const chef = startPi("json", ["--chef"], script);
  chef.proc.stdin!.end();
  assert.equal(await chef.exited, 0);
  const prompt = lastAssistantText(chef.events);
  assert.match(prompt, /## Cook models/);
  assert.match(prompt, /- deep: when a hard bug\. Why: it needs judgment\. Models: fake\/unknown, fake\/scripted \(thinking low\)\./);
  assert.match(prompt, /- docs: when docs only\. Models: fake\/scripted\./);
  assert.match(prompt, /- Default models: fake\/scripted\./);

  const dispatches = chef.events.filter((e) => e.type === "tool_execution_end" && e.toolName === "chef_dispatch").map((e) => e.result?.content?.map((c) => c.text ?? "").join("") ?? "");
  assert.match(dispatches[0]!, /Unknown model rule "nope"\. Rules: deep, docs\./);
  assert.match(dispatches[1]!, /^api-1 is cooking .* Skipped models: fake\/unknown \(Pi does not know this model\)\./);
  const spec = new Store(tk.kitchenDir).readSpec("api-1" as never);
  assert.deepEqual({ models: spec.models, rule: spec.rule }, { models: [{ model: FAKE_MODEL, thinking: "low" }], rule: "deep" });
});

async function chefBusyWhileCookFinishes(sleepSeconds: number) {
  tk = tempKitchen();
  const repo = makeRepo(tk.home, "api");
  const script = [
    `STEP tool chef_add_project ${JSON.stringify({ path: repo })}`,
    `STEP tool chef_dispatch ${JSON.stringify({ project: "api", title: "Quick", brief: REPORT_STEP("done", "quick") })}`,
    `STEP bash: sleep ${sleepSeconds}`,
    "STEP say: done",
  ].join("\n");
  const chef = startPi("rpc", ["--chef"]);
  chef.proc.stdin!.write(`${JSON.stringify({ id: "p1", type: "prompt", message: script })}\n`);
  const store = new Store(tk.kitchenDir);
  const sessionId = await until("the task", () => store.listTaskIds().map((id) => store.readSpec(id).sessionId)[0]);
  await until("the cook's exit", async () => ((await scanCooks()).has(sessionId) ? undefined : true));
  return { chef, store };
}

const wakeStarts = (events: Event[]) => events.filter((e) => e.type === "message_start" && e.message?.role === "custom" && e.message.customType === "chef-wake");
const settles = (events: Event[]) => events.filter((e) => e.type === "agent_settled").length;

test("a wake queued behind a busy chef turn is delivered as a follow-up and marked notified only then", async () => {
  const { chef, store } = await chefBusyWhileCookFinishes(8);
  await until("the chef's turn to settle", () => (settles(chef.events) >= 1 ? true : undefined), 60_000);
  await until("the wake", () => (wakeStarts(chef.events).length ? true : undefined), 15_000);
  chef.proc.stdin!.end();
  assert.equal(await chef.exited, 0);
  const wakes = wakeStarts(chef.events);
  assert.equal(wakes.length, 1);
  assert.ok(chef.events.indexOf(wakes[0]!) < chef.events.findIndex((e) => e.type === "agent_settled"), "the follow-up ran inside the busy turn");
  assert.deepEqual(store.readEvents(store.listTaskIds()[0]!).map((e) => e.type), ["notified"]);
});

test("a wake that Pi drops from its queue before delivery is derived and sent again after the turn settles", async () => {
  const { chef, store } = await chefBusyWhileCookFinishes(20);
  await new Promise((ok) => setTimeout(ok, WAKE_TIMING.maxWaitMs + 2 * TICK_MS));
  chef.proc.stdin!.write(`${JSON.stringify({ id: "c1", type: "clear_queue" })}\n`);
  await until("the chef's turn to settle", () => (settles(chef.events) >= 1 ? true : undefined), 60_000);
  const firstSettle = chef.events.findIndex((e) => e.type === "agent_settled");
  await until("the wake", () => (wakeStarts(chef.events).length ? true : undefined), 15_000).catch(() => undefined);
  chef.proc.stdin!.end();
  assert.equal(await chef.exited, 0);
  const wakes = wakeStarts(chef.events);
  assert.equal(wakes.length, 1, "the dropped wake was derived again and sent once");
  assert.ok(chef.events.indexOf(wakes[0]!) > firstSettle, "the wake came after the turn it was dropped from");
  assert.deepEqual(store.readEvents(store.listTaskIds()[0]!).map((e) => e.type), ["notified"]);
});

test("a role request gets chef while chef mode is on, and no role before /chef or after /chef off", async () => {
  tk = tempKitchen();
  const record = join(tk.home, "roles.txt");
  const pi = startPi("rpc", ["-e", ROLE_RECORDER], undefined, { ROLE_RECORD: record });
  const send = (id: string, message: string) => pi.proc.stdin!.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
  const answered = (id: string) => until(`response ${id}`, () => (pi.events.some((e) => e.type === "response" && e.id === id) ? true : undefined));
  const turn = async (id: string, settled: number) => {
    send(id, "STEP say: a");
    await until(`settle ${settled}`, () => (settles(pi.events) >= settled ? true : undefined), 30_000);
  };

  await turn("p1", 1);
  send("on", "/chef");
  await answered("on");
  await turn("p2", 2);
  send("off", "/chef off");
  await answered("off");
  await turn("p3", 3);
  pi.proc.stdin!.end();
  assert.equal(await pi.exited, 0);
  assert.deepEqual(readFileSync(record, "utf8").split("\n").filter(Boolean), ["none", "chef", "none"]);
});

test("the chef emits a cooks snapshot on each change, again on request, and role off on /chef off", async () => {
  tk = tempKitchen();
  const repo = makeRepo(tk.home, "api");
  const record = join(tk.home, "cooks.jsonl");
  const brief = `STEP bash: sleep ${(3 * TICK_MS) / 1000}\n${REPORT_STEP("done", "slept")}`;
  const script = [
    `STEP tool chef_add_project ${JSON.stringify({ path: repo })}`,
    `STEP tool chef_dispatch ${JSON.stringify({ project: "api", title: "Add a", brief })}`,
    "STEP say: dispatched",
    "STEP say: noted",
  ].join("\n");
  const chef = startPi("rpc", ["--chef", "-e", COOKS_RECORDER], undefined, { COOKS_RECORD: record });
  const send = (id: string, message: string) => chef.proc.stdin!.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
  const answered = (id: string) => until(`response ${id}`, () => (chef.events.some((e) => e.type === "response" && e.id === id) ? true : undefined));
  send("p1", script);
  await until("the wake turn to settle", () => (settles(chef.events) >= 2 ? true : undefined), 60_000);
  send("r1", "/cooks-request");
  await answered("r1");
  send("off", "/chef off");
  await answered("off");
  chef.proc.stdin!.end();
  assert.equal(await chef.exited, 0);

  const lines = readFileSync(record, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CooksSnapshot | { marker: string });
  const marker = lines.findIndex((l) => "marker" in l);
  assert.ok(marker > 0, "the request came after some snapshots");
  const ticks = lines.slice(0, marker) as CooksSnapshot[];
  const [answer, off, ...rest] = lines.slice(marker + 1) as CooksSnapshot[];
  const sessionId = ticks[0]!.sessionId;
  assert.ok(sessionId, "the snapshot names the chef session");
  assert.ok(ticks.every((s) => s.version === 1 && s.role === "owner" && s.sessionId === sessionId));
  for (let i = 1; i < ticks.length; i++) assert.notDeepEqual(ticks[i], ticks[i - 1], `snapshot ${i} repeats the one before it`);
  const states = ticks.map((s) => s.tasks.map((t) => (t.outcome ? `${t.state} ${t.outcome.kind}` : t.state)).join());
  assert.equal(states[0], "", "the first tick has no task");
  const cooking = states.indexOf("cooking");
  assert.ok(cooking > 0, "the task is seen cooking");
  assert.equal(states.at(-1), "idle done", "the task ends idle with its outcome");
  assert.ok(states.slice(cooking).every((s) => s === "cooking" || s === "idle done"), `cooking leads to idle done: ${states.join(" | ")}`);
  const id = ticks.at(-1)!.tasks[0]!.id;
  assert.equal(ticks.at(-1)!.tasks[0]!.outcome?.text, "slept");
  assert.equal(ticks.at(-1)!.tasks[0]!.transcript, join(tk.kitchenDir, "tasks", id, "runs", "1.jsonl"));
  assert.deepEqual(answer, ticks.at(-1), "a request gets the current snapshot again");
  assert.deepEqual(off, { version: 1, sessionId, role: "off", tasks: [] });
  assert.deepEqual(rest, [], "nothing is emitted after chef mode is off");
});

async function chefDispatchesOneTask(env: NodeJS.ProcessEnv) {
  tk = tempKitchen();
  const repo = makeRepo(tk.home, "api");
  const brief = `STEP bash: sleep ${(3 * TICK_MS) / 1000}\n${REPORT_STEP("done", "slept")}`;
  const script = [
    `STEP tool chef_add_project ${JSON.stringify({ path: repo })}`,
    `STEP tool chef_dispatch ${JSON.stringify({ project: "api", title: "Add a", brief })}`,
    "STEP say: dispatched",
    "STEP say: noted",
  ].join("\n");
  const log = join(tk.home, "herdr.log");
  const chef = startPi("rpc", ["--chef", "-e", HERDR_ADDON], undefined, { FAKE_HERDR_LOG: log, FAKE_HERDR_STATE: join(tk.home, "herdr.json"), HERDR_BIN_PATH: FAKE_HERDR, ...env });
  chef.proc.stdin!.write(`${JSON.stringify({ id: "p1", type: "prompt", message: script })}\n`);
  await until("the wake turn to settle", () => (settles(chef.events) >= 2 ? true : undefined), 60_000);
  await new Promise((ok) => setTimeout(ok, 2 * TICK_MS));
  chef.proc.stdin!.end();
  assert.equal(await chef.exited, 0);
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : undefined;
  return { calls, store: new Store(tk.kitchenDir) };
}

test("inside herdr the herdr add-on opens one cook tab per dispatched task and reports the cook's outcome", async () => {
  const { calls, store } = await chefDispatchesOneTask({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w9" });
  assert.ok(calls, "the chef called herdr");
  const id = store.listTaskIds()[0]!;
  const creates = calls.filter((c) => c[0] === "tab" && c[1] === "create");
  assert.deepEqual(creates, [["tab", "create", "--workspace", "w9", "--label", `cook ${id}`, "--cwd", store.readSpec(id).worktree, "--no-focus"]]);
  const runs = calls.filter((c) => c[0] === "pane" && c[1] === "run");
  assert.deepEqual(runs, [["pane", "run", "w9:p1", `exec 'node' '${join(ROOT, "extension/watch.ts")}' '${store.taskDir(id)}'`]]);
  const states = calls.filter((c) => c[1] === "report-agent").map((c) => c[c.indexOf("--state") + 1]);
  assert.equal(states[0], "working", "the cooking run is reported as working");
  assert.equal(states.at(-1), "idle", "the done outcome is reported as idle");
  assert.equal(states.filter((s) => s === "idle").length, 1, "the outcome is reported once");
});

test("without HERDR_ENV the herdr add-on never calls herdr", async () => {
  const { calls } = await chefDispatchesOneTask({ HERDR_WORKSPACE_ID: "w9" });
  assert.equal(calls, undefined);
});

test("with pi-subagents installed the subagents add-on shows the dispatched task as a FleetView job until /chef off", async () => {
  tk = tempKitchen();
  installFakeSubagents(join(tk.agentDir, "npm"));
  const repo = makeRepo(tk.home, "api");
  const log = join(tk.home, "fleet.log");
  const brief = `STEP bash: sleep ${(3 * TICK_MS) / 1000}\n${REPORT_STEP("done", "slept")}`;
  const script = [
    `STEP tool chef_add_project ${JSON.stringify({ path: repo })}`,
    `STEP tool chef_dispatch ${JSON.stringify({ project: "api", title: "Add a", brief })}`,
    "STEP say: dispatched",
    "STEP say: noted",
  ].join("\n");
  const chef = startPi("rpc", ["--chef", "-e", SUBAGENTS_ADDON], undefined, { FAKE_EXTERNAL_RUNS_LOG: log });
  chef.proc.stdin!.write(`${JSON.stringify({ id: "p1", type: "prompt", message: script })}\n`);
  await until("the wake turn to settle", () => (settles(chef.events) >= 2 ? true : undefined), 60_000);
  chef.proc.stdin!.write(`${JSON.stringify({ id: "off", type: "prompt", message: "/chef off" })}\n`);
  await until("response off", () => (chef.events.some((e) => e.type === "response" && e.id === "off") ? true : undefined));
  chef.proc.stdin!.end();
  assert.equal(await chef.exited, 0);

  type Call = ["register", { id: string; source: string; label: string; state: string; sessionId: string }] | ["update", string, string, { state: string }] | ["unregister", string, string];
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call);
  const id = new Store(tk.kitchenDir).listTaskIds()[0]!;
  const registers = calls.flatMap((c) => (c[0] === "register" ? [c[1]] : []));
  assert.deepEqual(registers.map((r) => [r.id, r.source, r.label]), [[`chef-${id}`, "pi-chef", `${id} Add a`]]);
  const states = calls.flatMap((c) => (c[0] === "register" ? [c[1].state] : c[0] === "update" ? [c[3].state] : []));
  assert.ok(states.includes("running"), `the cook is shown running: ${states.join()}`);
  assert.equal(states.at(-1), "completed", "the done outcome is shown completed");
  assert.deepEqual(calls.at(-1), ["unregister", registers[0]!.sessionId, `chef-${id}`], "/chef off removes the job");
});

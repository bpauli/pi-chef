// Chef e2e: a real `pi --mode rpc --chef` chef process on the fake model, which
// launches real cooks. Proves activation by flag and the wake path on real Pi.

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { after, afterEach, before, test } from "node:test";
import { scanCooks, signalCook } from "../extension/cooks.ts";
import { Store } from "../extension/store.ts";
import { CHEF_ENTRY, COMMIT_STEP, FAKE_MODEL, FAKE_PROVIDER, PI_CLI, REPORT_STEP, type TempKitchen, makeRepo, startFakeModel, tempKitchen, until } from "./support.ts";

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
  message?: { role: string; customType?: string; content?: unknown };
  toolName?: string;
  result?: { content?: { type: string; text?: string }[] };
}

/** Starts a chef Pi and collects its JSON events with an LF-only splitter. */
function startPi(mode: "json" | "rpc", extra: string[], prompt?: string): { proc: ChildProcess; events: Event[]; exited: Promise<number | null> } {
  const args = ["--mode", mode, "--no-session", "-ne", "-e", CHEF_ENTRY, "-e", FAKE_PROVIDER, "--model", FAKE_MODEL, ...extra];
  if (mode === "json") args.push("-p", prompt ?? "STEP say: hi");
  // CHEF_TEST_PI runs the chef on another Pi build, such as the compiled binary users install.
  const bin = process.env.CHEF_TEST_PI;
  const proc = bin
    ? spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env } })
    : spawn(process.execPath, [PI_CLI, ...args], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env } });
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
      } catch {
        // Not an event line.
      }
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
  assert.equal(wakes[0]!.message!.content, 'Kitchen update (1):\n- api-1 "Add a" is done: added a.txt Review with chef_result api-1.');
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

/** A chef whose turn is busy in bash while its cook finishes, so the wake is queued as a follow-up. */
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
  // The waker sends within 5 s of the notice; by now the wake sits in Pi's follow-up queue.
  await new Promise((ok) => setTimeout(ok, 7000));
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

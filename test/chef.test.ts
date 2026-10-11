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
  const args = [PI_CLI, "--mode", mode, "--no-session", "-ne", "-e", CHEF_ENTRY, "-e", FAKE_PROVIDER, "--model", FAKE_MODEL, ...extra];
  if (mode === "json") args.push("-p", prompt ?? "STEP say: hi");
  const proc = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env } });
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

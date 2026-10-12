import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ROOT, until } from "./support.ts";

const WATCH = join(ROOT, "extension/watch.ts");
const fixture = (name: string): string[] => readFileSync(join(ROOT, "test/fixtures", name), "utf8").split("\n").filter(Boolean);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function watcher(): { dir: string; out: () => string; exited: Promise<number | null>; proc: ChildProcess } {
  const dir = mkdtempSync(join(tmpdir(), "chef-watch-"));
  mkdirSync(join(dir, "runs"));
  const proc = spawn(process.execPath, [WATCH, dir], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => (out += chunk));
  const exited = new Promise<number | null>((ok) => proc.on("exit", (code) => ok(code)));
  cleanups.push(() => {
    proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, out: () => out, exited, proc };
}

const shows = (out: () => string, text: string) => until(`output ${JSON.stringify(text)}`, () => (out().includes(text) ? true : undefined), 10_000, 50);

test("the viewer shows each tool call, the streamed text, and the report while the run file grows", async () => {
  const w = watcher();
  await shows(w.out, "waiting for the first run");
  const done = fixture("done.jsonl");
  const toolEnd = done.findIndex((l) => l.includes('"tool_execution_end"'));
  const run = join(w.dir, "runs", "1.jsonl");
  writeFileSync(run, `${done.slice(0, toolEnd + 1).join("\n")}\n`);
  await shows(w.out, "▸ bash  echo hello");
  await shows(w.out, "  hello\n");
  assert.doesNotMatch(w.out(), /■ report/, "the report is not shown before its line exists");

  appendFileSync(run, `${done.slice(toolEnd + 1).join("\n")}\n`);
  await shows(w.out, "■ report: done\nechoed hello\n");
  await shows(w.out, "run ended");

  const text = `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "grüße" }], stopReason: "stop" } })}\n`;
  const bytes = Buffer.from(text);
  const cut = bytes.indexOf(Buffer.from("ü")) + 1;
  appendFileSync(run, bytes.subarray(0, cut));
  await new Promise((ok) => setTimeout(ok, 400));
  appendFileSync(run, bytes.subarray(cut));
  await shows(w.out, "grüße\n");
  assert.equal(w.out().includes("�"), false, "a character split across two appends is decoded whole");
});

test("the viewer prints a provider error in its run", async () => {
  const w = watcher();
  writeFileSync(join(w.dir, "runs", "1.jsonl"), `${fixture("provider-error.jsonl").join("\n")}\n`);
  await shows(w.out, "error: Connection error.");
  await shows(w.out, "run ended");
});

test("the viewer switches to a newer run file and marks the switch with the run number", async () => {
  const w = watcher();
  writeFileSync(join(w.dir, "runs", "1.jsonl"), `${fixture("done.jsonl").join("\n")}\n`);
  await shows(w.out, "■ report: done");
  writeFileSync(join(w.dir, "runs", "2.jsonl"), `${fixture("no-report.jsonl").join("\n")}\n`);
  await shows(w.out, "finished without a report");
  const out = w.out();
  assert.ok(out.indexOf("── run 1 ──") < out.indexOf("■ report: done"), "run 1 content follows its separator");
  assert.ok(out.indexOf("■ report: done") < out.indexOf("── run 2 ──"), "the run 2 separator follows run 1");
  assert.ok(out.indexOf("── run 2 ──") < out.indexOf("finished without a report"), "run 2 content follows its separator");
});

test("the viewer exits 0 when the task log records closed", async () => {
  const w = watcher();
  await shows(w.out, "waiting for the first run");
  appendFileSync(join(w.dir, "log.jsonl"), `${JSON.stringify({ type: "notified", at: 1, run: 1 })}\n`);
  await new Promise((ok) => setTimeout(ok, 600));
  assert.equal(w.proc.exitCode, null, "a log without closed keeps the viewer running");
  appendFileSync(join(w.dir, "log.jsonl"), `${JSON.stringify({ type: "closed", at: 2, discarded: false })}\n`);
  assert.equal(await w.exited, 0);
});

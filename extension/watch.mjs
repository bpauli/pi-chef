// @ts-check
// Runs under plain Node outside Pi, where Pi's peer dependencies (typebox) do
// not resolve for an installed package, so this file imports node builtins only.
// It is JavaScript because Node does not strip types from a .ts file under
// node_modules, which is where `pi install npm:pi-chef` puts it.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const POLL_MS = 250;
const CHUNK = 64 * 1024;
const TAIL_LINES = 3;
const PROMPT_LINES = 6;

/** @typedef {Record<string, unknown>} Obj */
/** @type {(v: unknown) => v is Obj} */
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** @type {(v: unknown) => string | undefined} */
const str = (v) => (typeof v === "string" ? v : undefined);
/** @type {(v: unknown, key: string) => unknown} */
const field = (v, key) => (isObj(v) ? v[key] : undefined);

const tty = process.stdout.isTTY === true;
/** @type {(code: string) => (text: string) => string} */
const paint = (code) => (text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = paint("2");
const red = paint("31");
const cyan = paint("36");
const bold = paint("1");
const green = paint("32");
const yellow = paint("33");

/** @type {() => number} */
const width = () => Math.max(40, (tty ? process.stdout.columns : undefined) ?? 160);
/** @type {(text: string, max?: number) => string} */
const clip = (text, max = width()) => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
};
/** @type {(text: string) => string} */
const flat = (text) => text.replace(/\s+/g, " ").trim();

let midLine = false;
/** @param {string} text */
function println(text) {
  process.stdout.write(`${midLine ? "\n" : ""}${text}\n`);
  midLine = false;
}
function endLine() {
  if (midLine) process.stdout.write("\n");
  midLine = false;
}
/** @param {string} text */
function stream(text) {
  if (!text) return;
  process.stdout.write(text);
  midLine = !text.endsWith("\n");
}

/** @type {(content: unknown) => string} */
const textParts = (content) =>
  Array.isArray(content) ? content.map((p) => (field(p, "type") === "text" ? (str(field(p, "text")) ?? "") : "")).join("") : (str(content) ?? "");

/**
 * @param {string} tool
 * @param {unknown} args
 * @returns {string}
 */
function keyArg(tool, args) {
  const pick = tool === "bash" ? field(args, "command") : (field(args, "path") ?? field(args, "file_path") ?? field(args, "pattern"));
  return flat(str(pick) ?? JSON.stringify(args ?? {}));
}

let streamedText = false;

/** @param {string} line */
function render(line) {
  /** @type {unknown} */
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  const type = field(ev, "type");
  const message = field(ev, "message");
  const role = field(message, "role");
  if (type === "message_update") {
    const update = field(ev, "assistantMessageEvent");
    if (field(update, "type") === "text_delta") {
      stream(str(field(update, "delta")) ?? "");
      streamedText = true;
    }
    return;
  }
  if (type === "message_start" && role === "assistant") {
    streamedText = false;
    return;
  }
  if (type === "message_end" && role === "user") {
    const lines = textParts(field(message, "content")).trim().split("\n");
    const shown = lines.slice(0, PROMPT_LINES).map((l) => cyan(clip(`› ${l}`)));
    if (lines.length > PROMPT_LINES) shown.push(dim(`  (${lines.length - PROMPT_LINES} more lines)`));
    println(shown.join("\n"));
    return;
  }
  if (type === "message_end" && role === "assistant") {
    const text = textParts(field(message, "content")).trim();
    if (!streamedText && text) stream(text);
    endLine();
    const error = str(field(message, "errorMessage"));
    if (error !== undefined || field(message, "stopReason") === "error") println(red(`error: ${error ?? "provider error"}`));
    return;
  }
  if (type === "tool_execution_start") {
    const tool = str(field(ev, "toolName")) ?? "tool";
    if (tool !== "chef_report") println(bold(clip(`▸ ${tool}  ${keyArg(tool, field(ev, "args"))}`)));
    return;
  }
  if (type === "tool_execution_end") {
    const tool = str(field(ev, "toolName"));
    const result = field(ev, "result");
    const report = field(result, "structuredContent");
    const status = str(field(report, "status"));
    if (tool === "chef_report" && status !== undefined) {
      const color = status === "done" ? green : yellow;
      println(color(bold(`■ report: ${status}`)));
      println(color(str(field(report, "summary")) ?? ""));
      return;
    }
    const out = textParts(field(result, "content")).trimEnd().split("\n").filter(Boolean).slice(-TAIL_LINES);
    const look = field(ev, "isError") === true ? red : dim;
    for (const l of out) println(look(clip(`  ${l}`)));
    return;
  }
  if (type === "auto_retry_start") {
    println(dim(`retry ${String(field(ev, "attempt"))}/${String(field(ev, "maxAttempts"))}: ${str(field(ev, "errorMessage")) ?? ""}`));
    return;
  }
  if (type === "agent_settled") println(dim("run ended"));
}

class Follower {
  #offset = 0;
  #partial = "";
  #decoder = new StringDecoder("utf8");
  /** @param {string} path */
  constructor(path) {
    /** @readonly */
    this.path = path;
  }

  drain() {
    /** @type {number} */
    let size;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size <= this.#offset) return;
    const fd = openSync(this.path, "r");
    try {
      const buf = Buffer.alloc(CHUNK);
      while (this.#offset < size) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, size - this.#offset), this.#offset);
        if (n <= 0) break;
        this.#offset += n;
        // LF only: U+2028 is legal inside a JSON string.
        const lines = (this.#partial + this.#decoder.write(buf.subarray(0, n))).split("\n");
        this.#partial = lines.pop() ?? "";
        for (const line of lines) if (line) render(line);
      }
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * @param {string} runsDir
 * @returns {number | undefined}
 */
function latestRun(runsDir) {
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(runsDir);
  } catch {
    return undefined;
  }
  const ns = names.map((n) => /^(\d+)\.jsonl$/.exec(n)?.[1]).filter((n) => n !== undefined).map(Number);
  return ns.length ? Math.max(...ns) : undefined;
}

/**
 * @param {string} logPath
 * @returns {boolean}
 */
function isClosed(logPath) {
  /** @type {string} */
  let text;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return false;
  }
  return text.split("\n").some((line) => {
    try {
      return field(JSON.parse(line), "type") === "closed";
    } catch {
      return false;
    }
  });
}

/** @param {string} taskDir */
function watch(taskDir) {
  const runsDir = join(taskDir, "runs");
  /** @type {{ n: number; follower: Follower } | undefined} */
  let run;
  let waiting = false;
  const poll = () => {
    const latest = latestRun(runsDir);
    if (latest !== undefined && latest !== run?.n) {
      run?.follower.drain();
      println(cyan(bold(`── run ${latest} ──`)));
      run = { n: latest, follower: new Follower(join(runsDir, `${latest}.jsonl`)) };
    }
    if (run === undefined && !waiting) {
      println(dim("waiting for the first run…"));
      waiting = true;
    }
    run?.follower.drain();
    if (isClosed(join(taskDir, "log.jsonl"))) {
      println(dim("task closed"));
      return;
    }
    setTimeout(poll, POLL_MS);
  };
  poll();
}

const taskDir = process.argv[2];
if (!taskDir) {
  process.stderr.write("usage: node watch.mjs <task dir>\n");
  process.exit(2);
}
watch(taskDir);

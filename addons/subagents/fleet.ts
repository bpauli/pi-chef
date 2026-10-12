import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { CooksSnapshot } from "../../extension/events.ts";

const SOURCE = "pi-chef";
const PACKAGE = "pi-subagents";
const ENTRY = "./external-runs";
/** EXTERNAL_RUN_LIMITS in pi-subagents/external-runs. */
const LIMITS = { text: 160, preview: 4096, path: 4096 };

const Task = Type.Object({
  id: Type.String(),
  title: Type.String(),
  state: Type.Union([Type.Literal("queued"), Type.Literal("cooking"), Type.Literal("idle")]),
  since: Type.Optional(Type.Number()),
  activity: Type.Optional(Type.String()),
  outcome: Type.Optional(
    Type.Object({ kind: Type.Union([Type.Literal("done"), Type.Literal("needs_decision"), Type.Literal("blocked"), Type.Literal("failed"), Type.Literal("stopped")]), text: Type.String() }),
  ),
  transcript: Type.Optional(Type.String()),
});
/** The fields of a cooks snapshot that this add-on reads. */
export const Snapshot = Type.Object({ version: Type.Literal(1), role: Type.Union([Type.Literal("owner"), Type.Literal("read-only"), Type.Literal("off")]), tasks: Type.Array(Task) });
export type Snapshot = Static<typeof Snapshot>;
export type CookTask = Static<typeof Task>;
type Assignable<T extends U, U> = T;
export type ContractFits = Assignable<CooksSnapshot, Snapshot>;

/** ExternalRun in pi-subagents/external-runs. */
export interface ExternalRun {
  id: string;
  sessionId: string;
  source: string;
  label: string;
  state: "queued" | "running" | "completed" | "failed" | "stopped";
  startedAt: number;
  updatedAt?: number;
  endedAt?: number;
  currentAction?: string;
  preview?: string;
  transcriptPath?: string;
}
type Display = Omit<ExternalRun, "id" | "sessionId" | "source">;

export interface ExternalRuns {
  registerExternalRun(run: ExternalRun): unknown;
  updateExternalRun(sessionId: string, id: string, update: { [K in keyof Display]: Display[K] | undefined }): unknown;
  unregisterExternalRun(sessionId: string, id: string): unknown;
}

const PackageJson = Type.Object({ exports: Type.Object({ [ENTRY]: Type.Object({ default: Type.String() }) }) });
function isApi(m: unknown): m is ExternalRuns {
  if (typeof m !== "object" || m === null) return false;
  return (
    "registerExternalRun" in m &&
    typeof m.registerExternalRun === "function" &&
    "updateExternalRun" in m &&
    typeof m.updateExternalRun === "function" &&
    "unregisterExternalRun" in m &&
    typeof m.unregisterExternalRun === "function"
  );
}

/**
 * Pi does not resolve one installed package from another, so the add-on reads
 * the installed package's exports map and imports the file by its absolute path.
 * Every copy writes to the same registry on globalThis, so any copy will do.
 */
export async function loadExternalRuns(roots: readonly string[]): Promise<ExternalRuns | undefined> {
  for (const root of roots) {
    const dir = join(root, "node_modules", PACKAGE);
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (!Value.Check(PackageJson, manifest)) continue;
    const file = resolve(dir, manifest.exports[ENTRY].default);
    const inside = relative(dir, file);
    if (inside.startsWith("..") || isAbsolute(inside)) continue;
    const mod: unknown = await import(pathToFileURL(file).href);
    if (isApi(mod)) return mod;
  }
  return undefined;
}

const clip = (text: string | undefined, max: number): string | undefined => {
  const flat = text?.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
};

const STATE = { done: "completed", failed: "failed", needs_decision: "stopped", blocked: "stopped", stopped: "stopped" } as const;
const LABEL = { done: "done", failed: "failed", needs_decision: "needs decision", blocked: "blocked", stopped: "stopped" } as const;

export const runId = (task: string): string => `chef-${task}`;

/** The display fields of one task. `startedAt` of an idle or queued task keeps the start of its last run. */
export function display(task: CookTask, now: number, startedBefore: number | undefined): Display {
  const startedAt = task.state === "cooking" ? (task.since ?? now) : (startedBefore ?? task.since ?? now);
  const label = clip(`${task.id} ${task.title}`, LIMITS.text) ?? task.id;
  const transcriptPath = task.transcript && task.transcript.length <= LIMITS.path ? task.transcript : undefined;
  if (task.state === "queued") return { label, state: "queued", startedAt, currentAction: "queued" };
  if (task.state === "cooking") return { label, state: "running", startedAt, currentAction: clip(task.activity, LIMITS.text), transcriptPath };
  const o = task.outcome ?? { kind: "stopped", text: "" };
  return {
    label,
    state: STATE[o.kind],
    startedAt,
    endedAt: task.since ?? now,
    currentAction: clip(o.text ? `${LABEL[o.kind]}: ${o.text}` : LABEL[o.kind], LIMITS.text),
    preview: clip(o.text, LIMITS.preview),
    transcriptPath,
  };
}

interface Shown {
  session: string;
  key: string;
  startedAt: number;
}

/** The records this add-on wrote to FleetView. It is their one writer. */
export class FleetRecords {
  private readonly shown = new Map<string, Shown>();
  private readonly api: ExternalRuns;

  constructor(api: ExternalRuns) {
    this.api = api;
  }

  apply(snapshot: Snapshot, session: string, now: number): string[] {
    if (snapshot.role === "off") return this.clear();
    const errors: string[] = [];
    const open = new Set(snapshot.tasks.map((t) => t.id));
    for (const id of [...this.shown.keys()]) if (!open.has(id)) this.remove(id, errors);
    for (const task of snapshot.tasks) {
      const before = this.shown.get(task.id);
      if (before && before.session !== session) this.remove(task.id, errors);
      const known = this.shown.get(task.id);
      const d = display(task, now, known?.startedAt);
      const key = JSON.stringify(d);
      if (known?.key === key) continue;
      const fields = { ...d, updatedAt: now };
      try {
        if (known) this.update(session, task.id, fields);
        else this.register(session, task.id, fields);
        this.shown.set(task.id, { session, key, startedAt: d.startedAt });
      } catch (e) {
        errors.push(`showing ${task.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return errors;
  }

  clear(): string[] {
    const errors: string[] = [];
    for (const id of [...this.shown.keys()]) this.remove(id, errors);
    return errors;
  }

  private register(session: string, task: string, fields: Display): void {
    try {
      this.api.registerExternalRun({ id: runId(task), sessionId: session, source: SOURCE, ...fields });
    } catch (e) {
      // The record can outlive an earlier copy of this add-on, for example across /reload.
      try {
        this.update(session, task, fields);
      } catch {
        throw e;
      }
    }
  }

  private update(session: string, task: string, d: Display): void {
    const { label, state, startedAt, updatedAt, endedAt, currentAction, preview, transcriptPath } = d;
    this.api.updateExternalRun(session, runId(task), { label, state, startedAt, updatedAt, endedAt, currentAction, preview, transcriptPath });
  }

  private remove(task: string, errors: string[]): void {
    const shown = this.shown.get(task);
    this.shown.delete(task);
    if (!shown) return;
    try {
      this.api.unregisterExternalRun(shown.session, runId(task));
    } catch (e) {
      errors.push(`removing ${task} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

import { execFile } from "node:child_process";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { CooksSnapshot } from "../../extension/events.ts";

const COOK_LABEL = /^cook (\S+)$/;
const MESSAGE_MAX = 120;
const CALL_TIMEOUT_MS = 10_000;

declare const brand: unique symbol;
export type PaneId = string & { readonly [brand]: "PaneId" };

const OutcomeKind = Type.Union([Type.Literal("done"), Type.Literal("needs_decision"), Type.Literal("blocked"), Type.Literal("failed"), Type.Literal("stopped")]);
const Task = Type.Object({
  id: Type.String(),
  state: Type.Union([Type.Literal("queued"), Type.Literal("cooking"), Type.Literal("idle")]),
  run: Type.Optional(Type.Number()),
  activity: Type.Optional(Type.String()),
  outcome: Type.Optional(Type.Object({ kind: OutcomeKind, text: Type.String() })),
  worktree: Type.String(),
  viewer: Type.Object({ command: Type.String(), args: Type.Array(Type.String()) }),
});
/** The fields of a cooks snapshot that this add-on reads. */
export const Snapshot = Type.Object({ version: Type.Literal(1), role: Type.Union([Type.Literal("owner"), Type.Literal("read-only"), Type.Literal("off")]), tasks: Type.Array(Task) });
export type Snapshot = Static<typeof Snapshot>;
export type CookTask = Static<typeof Task>;
type Assignable<T extends U, U> = T;
export type ContractFits = Assignable<CooksSnapshot, Snapshot>;

const TabCreated = Type.Object({ result: Type.Object({ root_pane: Type.Object({ pane_id: Type.String() }) }) });
const TabList = Type.Object({ result: Type.Object({ tabs: Type.Array(Type.Object({ tab_id: Type.String(), label: Type.String() })) }) });
const PaneList = Type.Object({ result: Type.Object({ panes: Type.Array(Type.Object({ pane_id: Type.String(), tab_id: Type.String() })) }) });
const ErrorReply = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.String() }) });

export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type HerdrState = "working" | "blocked" | "idle";
export interface HerdrReport {
  state: HerdrState;
  message: string;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function herdrReport(task: CookTask): HerdrReport | undefined {
  if (task.state === "cooking") return { state: "working", message: oneLine(task.activity ?? "cooking", MESSAGE_MAX) };
  const o = task.outcome;
  if (task.state !== "idle" || !o) return undefined;
  if (o.kind === "done" || o.kind === "stopped") return { state: "idle", message: o.kind };
  const label = o.kind === "needs_decision" ? "needs decision" : o.kind;
  return { state: "blocked", message: oneLine(`${label}: ${o.text}`, MESSAGE_MAX) };
}

export const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export class Herdr {
  readonly bin: string;
  readonly workspace: string;
  constructor(bin: string, workspace: string) {
    this.bin = bin;
    this.workspace = workspace;
  }

  static fromEnv(env: NodeJS.ProcessEnv): Herdr | undefined {
    if (env.HERDR_ENV !== "1" || !env.HERDR_WORKSPACE_ID) return undefined;
    return new Herdr(env.HERDR_BIN_PATH || "herdr", env.HERDR_WORKSPACE_ID);
  }

  private run(args: string[]): Promise<unknown> {
    return new Promise((ok, fail) => {
      execFile(this.bin, args, { encoding: "utf8", timeout: CALL_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) {
          const reply = parseJson(stderr);
          fail(Value.Check(ErrorReply, reply) ? new HerdrError(reply.error.code, reply.error.message) : new HerdrError("exec", oneLine(stderr || err.message, 200)));
          return;
        }
        ok(parseJson(stdout));
      });
    });
  }

  private async call<T extends TSchema>(schema: T, args: string[]): Promise<Static<T>> {
    const reply = await this.run(args);
    if (!Value.Check(schema, reply)) throw new HerdrError("reply", `herdr ${args.slice(0, 2).join(" ")} gave an unexpected reply`);
    return reply;
  }

  async cookTabs(): Promise<Map<string, PaneId>> {
    const [tabs, panes] = await Promise.all([
      this.call(TabList, ["tab", "list", "--workspace", this.workspace]),
      this.call(PaneList, ["pane", "list", "--workspace", this.workspace]),
    ]);
    const paneOfTab = new Map<string, string>();
    for (const p of panes.result.panes) if (!paneOfTab.has(p.tab_id)) paneOfTab.set(p.tab_id, p.pane_id);
    const found = new Map<string, PaneId>();
    for (const t of tabs.result.tabs) {
      const task = COOK_LABEL.exec(t.label)?.[1];
      const pane = paneOfTab.get(t.tab_id);
      if (task !== undefined && pane !== undefined) found.set(task, paneId(pane));
    }
    return found;
  }

  async openCookTab(task: CookTask): Promise<PaneId> {
    const created = await this.call(TabCreated, ["tab", "create", "--workspace", this.workspace, "--label", `cook ${task.id}`, "--cwd", task.worktree, "--no-focus"]);
    const pane = paneId(created.result.root_pane.pane_id);
    const { command, args } = task.viewer;
    await this.run(["pane", "run", pane, `exec ${[command, ...args].map(shellQuote).join(" ")}`]);
    return pane;
  }

  async report(pane: PaneId, r: HerdrReport): Promise<void> {
    await this.run(["pane", "report-agent", pane, "--source", "chef", "--agent", "cook", "--state", r.state, "--message", r.message]);
  }
}

const paneId = (raw: string): PaneId => raw as PaneId;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface CookTab {
  /** The last run seen cooking. A tab opens at most once per run. */
  run: number | undefined;
  pane: PaneId | undefined;
  shown: string | undefined;
}

export class CookTabs {
  private readonly tabs = new Map<string, CookTab>();
  private adopted = false;
  private readonly herdr: Herdr;

  constructor(herdr: Herdr) {
    this.herdr = herdr;
  }

  private tab(id: string): CookTab {
    let tab = this.tabs.get(id);
    if (!tab) this.tabs.set(id, (tab = { run: undefined, pane: undefined, shown: undefined }));
    return tab;
  }

  private static attach(tab: CookTab, pane: PaneId | undefined): void {
    if (tab.pane !== pane) tab.shown = undefined;
    tab.pane = pane;
  }

  /** Only the owner session writes to the tabs. Any other role forgets them, so the next owner snapshot adopts the live tabs again. */
  async apply(snapshot: Snapshot): Promise<string[]> {
    if (snapshot.role === "owner") return this.sync(snapshot.tasks);
    this.tabs.clear();
    this.adopted = false;
    return [];
  }

  private async sync(tasks: readonly CookTask[]): Promise<string[]> {
    const open = new Set(tasks.map((t) => t.id));
    for (const id of this.tabs.keys()) if (!open.has(id)) this.tabs.delete(id);
    const fresh = tasks.filter((t) => t.state === "cooking" && this.tab(t.id).run !== t.run);
    const errors: string[] = [];
    if (!this.adopted || fresh.length) {
      let live: Map<string, PaneId>;
      try {
        live = await this.herdr.cookTabs();
      } catch (e) {
        return [`herdr: ${errorMessage(e)}`];
      }
      this.adopted = true;
      for (const t of tasks) CookTabs.attach(this.tab(t.id), live.get(t.id));
      for (const t of fresh) {
        const tab = this.tab(t.id);
        tab.run = t.run;
        if (tab.pane) continue;
        try {
          CookTabs.attach(tab, await this.herdr.openCookTab(t));
        } catch (e) {
          errors.push(`herdr: opening the tab of ${t.id} failed: ${errorMessage(e)}`);
        }
      }
    }
    for (const t of tasks) {
      const tab = this.tabs.get(t.id);
      const want = herdrReport(t);
      if (!tab?.pane || !want) continue;
      const key = `${want.state} ${want.message}`;
      if (key === tab.shown) continue;
      try {
        await this.herdr.report(tab.pane, want);
        tab.shown = key;
      } catch (e) {
        if (e instanceof HerdrError && e.code === "pane_not_found") tab.pane = undefined;
        else errors.push(`herdr: reporting ${t.id} failed: ${errorMessage(e)}`);
      }
    }
    return errors;
  }
}

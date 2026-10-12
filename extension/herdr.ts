import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { activityText, oneLine, outcomeDetail, outcomeText } from "./derive.ts";
import { type PaneId, type RunNo, type TaskId, type TaskState, type TaskView, errorMessage } from "./domain.ts";

export const WATCH_SCRIPT = fileURLToPath(new URL("./watch.ts", import.meta.url));
const COOK_LABEL = /^cook (\S+)$/;
const MESSAGE_MAX = 120;
const CALL_TIMEOUT_MS = 10_000;

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

export function herdrReport(state: TaskState): HerdrReport | undefined {
  if (state.kind === "cooking") return { state: "working", message: oneLine(activityText(state.activity), MESSAGE_MAX) };
  if (state.kind !== "idle") return undefined;
  const o = state.outcome;
  if (o.kind === "done" || o.kind === "stopped") return { state: "idle", message: outcomeText(o) };
  return { state: "blocked", message: oneLine(`${outcomeText(o)}: ${outcomeDetail(o)}`, MESSAGE_MAX) };
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

  async openCookTab(task: TaskId, worktree: string, taskDir: string): Promise<PaneId> {
    const created = await this.call(TabCreated, ["tab", "create", "--workspace", this.workspace, "--label", `cook ${task}`, "--cwd", worktree, "--no-focus"]);
    const pane = paneId(created.result.root_pane.pane_id);
    await this.run(["pane", "run", pane, `exec node ${shellQuote(WATCH_SCRIPT)} ${shellQuote(taskDir)}`]);
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
  run: RunNo | undefined;
  pane: PaneId | undefined;
  shown: string | undefined;
}

export class CookTabs {
  private readonly tabs = new Map<TaskId, CookTab>();
  private adopted = false;
  private readonly herdr: Herdr;
  private readonly taskDir: (id: TaskId) => string;

  constructor(herdr: Herdr, taskDir: (id: TaskId) => string) {
    this.herdr = herdr;
    this.taskDir = taskDir;
  }

  private tab(id: TaskId): CookTab {
    let tab = this.tabs.get(id);
    if (!tab) this.tabs.set(id, (tab = { run: undefined, pane: undefined, shown: undefined }));
    return tab;
  }

  private static attach(tab: CookTab, pane: PaneId | undefined): void {
    if (tab.pane !== pane) tab.shown = undefined;
    tab.pane = pane;
  }

  async sync(views: readonly TaskView[]): Promise<string[]> {
    const open = new Set(views.map((v) => v.spec.id));
    for (const id of this.tabs.keys()) if (!open.has(id)) this.tabs.delete(id);
    const fresh = views.flatMap((v) => (v.state.kind === "cooking" && this.tab(v.spec.id).run !== v.state.run ? [{ spec: v.spec, run: v.state.run }] : []));
    const errors: string[] = [];
    if (!this.adopted || fresh.length) {
      let live: Map<string, PaneId>;
      try {
        live = await this.herdr.cookTabs();
      } catch (e) {
        return [`herdr: ${errorMessage(e)}`];
      }
      this.adopted = true;
      for (const v of views) CookTabs.attach(this.tab(v.spec.id), live.get(v.spec.id));
      for (const { spec, run } of fresh) {
        const tab = this.tab(spec.id);
        tab.run = run;
        if (tab.pane) continue;
        try {
          CookTabs.attach(tab, await this.herdr.openCookTab(spec.id, spec.worktree, this.taskDir(spec.id)));
        } catch (e) {
          errors.push(`herdr: opening the tab of ${spec.id} failed: ${errorMessage(e)}`);
        }
      }
    }
    for (const v of views) {
      const tab = this.tabs.get(v.spec.id);
      const want = herdrReport(v.state);
      if (!tab?.pane || !want) continue;
      const key = `${want.state} ${want.message}`;
      if (key === tab.shown) continue;
      try {
        await this.herdr.report(tab.pane, want);
        tab.shown = key;
      } catch (e) {
        if (e instanceof HerdrError && e.code === "pane_not_found") tab.pane = undefined;
        else errors.push(`herdr: reporting ${v.spec.id} failed: ${errorMessage(e)}`);
      }
    }
    return errors;
  }
}

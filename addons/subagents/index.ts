import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { FleetRecords, Snapshot, loadExternalRuns } from "./fleet.ts";

const COOKS_EVENT: typeof import("../../extension/events.ts").COOKS_EVENT = "pi-chef:cooks:v1";
const COOKS_REQUEST_EVENT: typeof import("../../extension/events.ts").COOKS_REQUEST_EVENT = "pi-chef:cooks:v1:request";

const agentDir = (): string => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

/** FleetView lists the external runs of `getSessionFile() ?? getSessionId()`, not of the session id alone. */
const fleetSession = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();

export default function chefSubagents(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let session: string | undefined;
  let latest: Snapshot | undefined;
  let lookup: Promise<FleetRecords | undefined> | undefined;
  let fleet: FleetRecords | undefined;
  let shownErrors = new Set<string>();

  const notify = (text: string, level: "info" | "error"): void => {
    if (!ctx?.hasUI) return;
    try {
      ctx.ui.notify(`pi-chef-subagents: ${text}`, level);
    } catch {}
  };

  const find = async (cwd: string): Promise<FleetRecords | undefined> => {
    try {
      const api = await loadExternalRuns([join(cwd, ".pi", "npm"), join(agentDir(), "npm")]);
      if (api) return new FleetRecords(api);
      notify("pi-subagents is not installed, so FleetView shows no cooks.", "info");
    } catch (e) {
      notify(`loading pi-subagents failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
    return undefined;
  };

  const sync = async (): Promise<void> => {
    if (!ctx || !session || !latest) return;
    if (!fleet && latest.role === "off") return;
    fleet = await (lookup ??= find(ctx.cwd));
    if (!fleet || !session || !latest) return;
    const errors = fleet.apply(latest, session, Date.now());
    for (const err of errors) if (!shownErrors.has(err)) notify(err, "error");
    shownErrors = new Set(errors);
  };

  pi.events.on(COOKS_EVENT, (data) => {
    if (!Value.Check(Snapshot, data)) return;
    latest = data;
    return sync();
  });
  pi.on("session_start", async (_event, c) => {
    ctx = c;
    session = fleetSession(c);
    pi.events.emit(COOKS_REQUEST_EVENT, undefined);
    await sync();
  });
  pi.on("session_shutdown", () => {
    fleet?.clear();
    latest = undefined;
    session = undefined;
    ctx = undefined;
  });
}

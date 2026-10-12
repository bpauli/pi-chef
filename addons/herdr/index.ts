import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { CookTabs, Herdr, Snapshot } from "./herdr.ts";

const COOKS_EVENT: typeof import("../../extension/events.ts").COOKS_EVENT = "pi-chef:cooks:v1";
const COOKS_REQUEST_EVENT: typeof import("../../extension/events.ts").COOKS_REQUEST_EVENT = "pi-chef:cooks:v1:request";

export default function chefHerdr(pi: ExtensionAPI): void {
  const herdr = Herdr.fromEnv(process.env);
  if (!herdr) return;
  const tabs = new CookTabs(herdr);
  let ctx: ExtensionContext | undefined;
  let shown = new Set<string>();
  let latest: Snapshot | undefined;
  let syncing = false;

  const notify = (errors: readonly string[]): void => {
    for (const err of errors) {
      if (shown.has(err) || !ctx?.hasUI) continue;
      try {
        ctx.ui.notify(`pi-chef-herdr: ${err}`, "error");
      } catch {}
    }
    shown = new Set(errors);
  };

  // herdr calls take time and snapshots can arrive faster. One sync runs at a time, on the newest snapshot.
  const drain = async (): Promise<void> => {
    if (syncing) return;
    syncing = true;
    try {
      while (latest) {
        const snapshot = latest;
        latest = undefined;
        notify(await tabs.apply(snapshot));
      }
    } finally {
      syncing = false;
    }
  };

  pi.events.on(COOKS_EVENT, (data) => {
    if (!Value.Check(Snapshot, data)) return;
    latest = data;
    void drain();
  });
  pi.on("session_start", (_event, c) => {
    ctx = c;
    pi.events.emit(COOKS_REQUEST_EVENT, undefined);
  });
  pi.on("session_shutdown", () => {
    ctx = undefined;
  });
}

// Appends every pi-chef cooks snapshot to COOKS_RECORD. `/cooks-request` asks
// chef for its current snapshot and first appends a marker line.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { COOKS_EVENT, COOKS_REQUEST_EVENT } from "../extension/events.ts";

export const REQUEST_MARKER = { marker: "request" };

export default function cooksRecorder(pi: ExtensionAPI) {
  const file = process.env.COOKS_RECORD;
  if (!file) return;
  pi.events.on(COOKS_EVENT, (data) => appendFileSync(file, `${JSON.stringify(data)}\n`));
  pi.registerCommand("cooks-request", {
    description: "Ask chef for its current cooks snapshot.",
    handler: async () => {
      appendFileSync(file, `${JSON.stringify(REQUEST_MARKER)}\n`);
      pi.events.emit(COOKS_REQUEST_EVENT, undefined);
    },
  });
}

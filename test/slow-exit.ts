// A cook extension for the e2e tests. Pi awaits session_shutdown handlers after
// agent_settled, so this keeps the cook process alive for SLOW_EXIT_MS after its
// run file shows settled. That makes the exit window a certainty, not a race.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setTimeout as sleep } from "node:timers/promises";

export const SLOW_EXIT_MS = 1500;

export default function slowExit(pi: ExtensionAPI) {
  pi.on("session_shutdown", () => sleep(SLOW_EXIT_MS));
}

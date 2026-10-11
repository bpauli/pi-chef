// Pi awaits session_shutdown handlers after agent_settled, and the interval keeps
// the event loop alive, so this cook process never exits by itself.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function neverExit(pi: ExtensionAPI) {
  pi.on("session_shutdown", () => {
    setInterval(() => undefined, 1000);
    return new Promise<void>(() => undefined);
  });
}

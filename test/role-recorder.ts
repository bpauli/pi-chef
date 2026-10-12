// At each turn start, asks for the pi-chef role and appends the answer, or
// `none`, to ROLE_RECORD. It reads the answer right after `emit` returns.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { ROLE_EVENT, type RoleRequest } from "../extension/events.ts";

export default function roleRecorder(pi: ExtensionAPI) {
  const file = process.env.ROLE_RECORD;
  if (!file) return;
  pi.on("before_agent_start", () => {
    const request: RoleRequest = { version: 1 };
    pi.events.emit(ROLE_EVENT, request);
    appendFileSync(file, `${request.role ?? "none"}\n`);
  });
}

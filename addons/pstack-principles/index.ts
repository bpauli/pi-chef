import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RoleRequest } from "../../extension/events.ts";
import { loadPrinciples, principlesBlock } from "./principles.ts";

const ROLE_EVENT: typeof import("../../extension/events.ts").ROLE_EVENT = "pi-chef:role:v1";

export default function pstackPrinciples(pi: ExtensionAPI): void {
  const principles = loadPrinciples();
  const blocks = { chef: principlesBlock("chef", principles), cook: principlesBlock("cook", principles) };

  pi.on("before_agent_start", (event) => {
    const request: RoleRequest = { version: 1 };
    pi.events.emit(ROLE_EVENT, request);
    const block = request.role ? blocks[request.role] : undefined;
    if (block === undefined) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });
}

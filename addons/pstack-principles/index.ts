import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { RoleRequest } from "../../extension/events.ts";
import { loadPrinciples, principlesBlock } from "./principles.ts";

const ROLE_EVENT: typeof import("../../extension/events.ts").ROLE_EVENT = "pi-chef:role:v1";
const PRINCIPLE_SETS_EVENT: typeof import("../../extension/events.ts").PRINCIPLE_SETS_EVENT = "pi-chef:principle-sets:v1";
const SET = "pstack";
const SetsRequestSchema = Type.Object({ version: Type.Literal(1), sets: Type.Array(Type.String()) });

export default function pstackPrinciples(pi: ExtensionAPI): void {
  const principles = loadPrinciples();
  const blocks = { chef: principlesBlock("chef", principles), cook: principlesBlock("cook", principles) };

  pi.events.on(PRINCIPLE_SETS_EVENT, (data) => {
    if (Value.Check(SetsRequestSchema, data)) data.sets.push(SET);
  });

  pi.on("before_agent_start", (event) => {
    const request: RoleRequest = { version: 1 };
    pi.events.emit(ROLE_EVENT, request);
    if (!request.role || (request.principleSet !== undefined && request.principleSet !== SET)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${blocks[request.role]}` };
  });
}

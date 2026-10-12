import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { RoleRequest } from "../../extension/events.ts";
import { loadSkills, superpowersBlock } from "./superpowers.ts";

const ROLE_EVENT: typeof import("../../extension/events.ts").ROLE_EVENT = "pi-chef:role:v1";
const PRINCIPLE_SETS_EVENT: typeof import("../../extension/events.ts").PRINCIPLE_SETS_EVENT = "pi-chef:principle-sets:v1";
const SET = "superpowers";
const SetsRequestSchema = Type.Object({ version: Type.Literal(1), sets: Type.Array(Type.String()) });

export default function superpowersPrinciples(pi: ExtensionAPI): void {
  const skills = loadSkills();
  const blocks = { chef: superpowersBlock("chef", skills), cook: superpowersBlock("cook", skills) };

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

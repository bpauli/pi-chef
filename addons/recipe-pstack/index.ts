import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { RoleRequest } from "../../extension/events.ts";
import { loadPrinciples, principlesBlock } from "./principles.ts";

const ROLE_EVENT: typeof import("../../extension/events.ts").ROLE_EVENT = "pi-chef:role:v1";
const RECIPES_EVENT: typeof import("../../extension/events.ts").RECIPES_EVENT = "pi-chef:recipes:v1";
const RECIPE = "pstack";
const RecipesRequestSchema = Type.Object({ version: Type.Literal(1), recipes: Type.Array(Type.String()) });

export default function pstackRecipe(pi: ExtensionAPI): void {
  const principles = loadPrinciples();
  const blocks = { chef: principlesBlock("chef", principles), cook: principlesBlock("cook", principles) };

  pi.events.on(RECIPES_EVENT, (data) => {
    if (Value.Check(RecipesRequestSchema, data)) data.recipes.push(RECIPE);
  });

  pi.on("before_agent_start", (event) => {
    const request: RoleRequest = { version: 1 };
    pi.events.emit(ROLE_EVENT, request);
    if (!request.role || (request.recipe !== undefined && request.recipe !== RECIPE)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${blocks[request.role]}` };
  });
}

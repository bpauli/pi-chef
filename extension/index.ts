// Package entry: the double-load guard and the role switch.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installCook } from "./cook.ts";
import { ROLE_ENV } from "./cooks.ts";

// A cook is launched with `-e <this file>` and may also have chef installed as a
// package. Two copies that register the same tool name are a fatal load error.
const LOADED = Symbol.for("chef.loaded");

export default async function chef(pi: ExtensionAPI): Promise<void> {
  const g = globalThis as { [LOADED]?: true };
  if (g[LOADED]) return;
  g[LOADED] = true;
  // /reload re-runs the factories in the same process. Without this the reloaded copy would register nothing.
  pi.on("session_shutdown", () => {
    delete g[LOADED];
  });
  if (process.env[ROLE_ENV] === "cook") {
    installCook(pi, process.env);
    return;
  }
  // The cook process never loads the chef half.
  const { installChef } = await import("./chef.ts");
  installChef(pi);
}

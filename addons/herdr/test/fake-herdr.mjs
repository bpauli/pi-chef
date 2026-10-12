#!/usr/bin/env node
// Stands in for the herdr CLI. Appends its argv to FAKE_HERDR_LOG and keeps its tabs in FAKE_HERDR_STATE.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const { FAKE_HERDR_LOG: log, FAKE_HERDR_STATE: statePath } = process.env;
appendFileSync(log, `${JSON.stringify(args)}\n`);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { next: 1, tabs: [] };
const flag = (name) => args[args.indexOf(name) + 1];
const reply = (result) => process.stdout.write(`${JSON.stringify({ id: "fake", result })}\n`);
const fail = (code, message) => {
  process.stderr.write(`${JSON.stringify({ error: { code, message }, id: "fake" })}\n`);
  process.exit(1);
};
const ws = flag("--workspace");
const verb = args.slice(0, 2).join(" ");

if (verb === "tab create") {
  const n = state.next++;
  const tab = { tab_id: `${ws}:t${n}`, label: flag("--label"), pane_id: `${ws}:p${n}`, cwd: flag("--cwd") };
  state.tabs.push(tab);
  writeFileSync(statePath, JSON.stringify(state));
  reply({ tab: { tab_id: tab.tab_id, label: tab.label }, root_pane: { pane_id: tab.pane_id } });
} else if (verb === "tab list") {
  reply({ tabs: state.tabs.map((t) => ({ tab_id: t.tab_id, label: t.label })) });
} else if (verb === "pane list") {
  reply({ panes: state.tabs.map((t) => ({ pane_id: t.pane_id, tab_id: t.tab_id })) });
} else if (verb === "pane run" || verb === "pane report-agent") {
  if (!state.tabs.some((t) => t.pane_id === args[2])) fail("pane_not_found", `pane ${args[2]} not found`);
  reply({});
} else {
  fail("unknown", `fake herdr does not know ${verb}`);
}

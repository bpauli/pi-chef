// Stands in for pi-subagents/external-runs. Records each call, also as a line in
// FAKE_EXTERNAL_RUNS_LOG when set, and keeps the runs by session and id, with
// the duplicate and missing-run errors of the real API.
import { appendFileSync } from "node:fs";

export const calls = [];
export const runs = new Map();
const key = (sessionId, id) => `${sessionId}\0${id}`;

function record(call) {
  calls.push(call);
  if (process.env.FAKE_EXTERNAL_RUNS_LOG) appendFileSync(process.env.FAKE_EXTERNAL_RUNS_LOG, `${JSON.stringify(call)}\n`);
}

export function registerExternalRun(run) {
  record(["register", run]);
  if (runs.has(key(run.sessionId, run.id))) throw new Error(`External run '${run.id}' is already registered for session '${run.sessionId}'.`);
  runs.set(key(run.sessionId, run.id), { ...run });
  return { ...run };
}

export function updateExternalRun(sessionId, id, update) {
  record(["update", sessionId, id, update]);
  const previous = runs.get(key(sessionId, id));
  if (!previous) throw new Error(`External run '${id}' is not registered for session '${sessionId}'.`);
  const next = Object.fromEntries(Object.entries({ ...previous, ...update }).filter(([, v]) => v !== undefined));
  runs.set(key(sessionId, id), next);
  return { ...next };
}

export function unregisterExternalRun(sessionId, id) {
  record(["unregister", sessionId, id]);
  return runs.delete(key(sessionId, id));
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A stand-in ExtensionAPI with an in-process event bus, for add-on tests. */
export function fakePi(cwd = process.cwd()) {
  const handlers = new Map<string, Handler[]>();
  const listeners = new Map<string, ((data: unknown) => unknown)[]>();
  const emitted: { channel: string; data: unknown }[] = [];
  const notices: { text: string; level: string }[] = [];
  const ctx = {
    cwd,
    hasUI: true,
    ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
    sessionManager: { getSessionId: () => "sid-1", getSessionFile: () => "/sessions/sid-1.jsonl" },
  };
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: {
      emit: (channel: string, data: unknown) => {
        emitted.push({ channel, data });
        for (const l of listeners.get(channel) ?? []) void l(data);
      },
      on: (channel: string, listener: (data: unknown) => unknown) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
        return () => undefined;
      },
    },
  };
  const lifecycle = async (event: string): Promise<void> => {
    for (const h of handlers.get(event) ?? []) await h({ type: event }, ctx);
  };
  return { pi: pi as unknown as ExtensionAPI, lifecycle, emitted, notices, ctx };
}

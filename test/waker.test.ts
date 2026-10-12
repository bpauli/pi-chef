import assert from "node:assert/strict";
import { test } from "node:test";
import type { Notice, TaskId } from "../extension/domain.ts";
import { runNo } from "../extension/domain.ts";
import { Waker } from "../extension/chef.ts";

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: ((fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: ((id: unknown) => void timers.delete(id as number)) as typeof clearTimeout,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        timers.delete(id);
        t.fn();
      }
    },
  };
}

const notice = (task: string, run = 1): Notice => ({ task: task as TaskId, title: task, run: runNo(run), model: undefined, tried: [], outcome: { kind: "done", summary: "s", reported: true } });

test("the waker holds the first notice for the quiet window, and a second notice extends it into the same wake", () => {
  const clock = fakeClock();
  const wakes: Notice[][] = [];
  const waker = new Waker((n) => wakes.push(n), { quietMs: 1500, maxWaitMs: 5000 }, clock);
  waker.offer([notice("api-1")]);
  clock.advance(1000);
  assert.equal(wakes.length, 0);
  waker.offer([notice("web-2")]);
  clock.advance(1000);
  assert.equal(wakes.length, 0, "the second notice re-opened the quiet window");
  clock.advance(600);
  assert.deepEqual(wakes.map((w) => w.map((n) => n.task)), [["api-1", "web-2"]]);
});

test("the waker delivers after the cap even while notices keep arriving, and a repeated task#run is offered once", () => {
  const clock = fakeClock();
  const wakes: Notice[][] = [];
  const waker = new Waker((n) => wakes.push(n), { quietMs: 1500, maxWaitMs: 5000 }, clock);
  for (let i = 0; i < 5; i++) {
    waker.offer([notice("api-1"), notice(`t-${i}`)]);
    clock.advance(1000);
  }
  const tasks = (w: Notice[] | undefined) => (w ?? []).map((n) => n.task);
  assert.equal(wakes.length, 1, "the cap at 5 s delivered while notices kept arriving every second");
  assert.deepEqual(tasks(wakes[0]), ["api-1", "t-0", "t-1", "t-2", "t-3", "t-4"]);
  waker.offer([notice("t-5")]);
  clock.advance(1500);
  assert.deepEqual(tasks(wakes[1]), ["t-5"]);
});

test("a notice stays in flight after its wake is sent, so a re-derived notice is not sent twice until the wake is confirmed", () => {
  const clock = fakeClock();
  const wakes: Notice[][] = [];
  const waker = new Waker((n) => wakes.push(n), { quietMs: 100, maxWaitMs: 500 }, clock);
  waker.offer([notice("api-1")]);
  clock.advance(100);
  assert.equal(wakes.length, 1);
  waker.offer([notice("api-1")]);
  clock.advance(1000);
  assert.equal(wakes.length, 1, "the same task#run is in flight and not sent again");
  waker.delivered([notice("api-1")]);
  waker.offer([notice("api-1")]);
  clock.advance(100);
  assert.equal(wakes.length, 2, "after confirmation the notice is free to be offered again");
});

test("a wake that was not confirmed when the agent settled was dropped by Pi, so the re-derived notice is sent again", () => {
  const clock = fakeClock();
  const wakes: Notice[][] = [];
  const waker = new Waker((n) => wakes.push(n), { quietMs: 100, maxWaitMs: 500 }, clock);
  waker.offer([notice("api-1")]);
  clock.advance(100);
  waker.settled();
  waker.offer([notice("api-1")]);
  clock.advance(100);
  assert.deepEqual(wakes.map((w) => w.map((n) => n.task)), [["api-1"], ["api-1"]]);
});

test("dispose drops pending notices so nothing is delivered after shutdown", () => {
  const clock = fakeClock();
  const wakes: Notice[][] = [];
  const waker = new Waker((n) => wakes.push(n), { quietMs: 100, maxWaitMs: 500 }, clock);
  waker.offer([notice("api-1")]);
  waker.dispose();
  clock.advance(1000);
  assert.equal(wakes.length, 0);
});

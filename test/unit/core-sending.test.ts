// Queue, batching, triggers, response handling, retry and consent (protocol 3, 4 and 12).
import { describe, expect, it } from "vitest";
import { names, rig } from "../support/fakes";


describe("triggers", () => {
  it("flushAt sends once the queue reaches it; launch alone sends nothing", async () => {
    const r = await rig({ flushAtCount: 5 });
    expect(r.transport.sent).toHaveLength(0);
    for (let i = 0; i < 3; i++) r.core.track("t");
    await r.settle();
    expect(r.transport.sent).toHaveLength(1);
    expect(r.transport.sent[0].body.batch).toHaveLength(5);
  });

  it("the interval sends every flushInterval while the queue is not empty", async () => {
    const r = await rig();
    await r.advance(14_999);
    expect(r.transport.sent).toHaveLength(0);
    await r.advance(1);
    expect(r.transport.sent).toHaveLength(1);
    await r.advance(60_000);
    expect(r.transport.sent).toHaveLength(1);
    expect(r.clock.pending()).toBe(0);
  });

  it("persists every event before the request that carries it", async () => {
    const r = await rig();
    r.core.track("a");
    await r.core.flush();
    expect(r.storage.log).toEqual(["append:2", "append:1", "send"]);
    expect(r.storage.queue).toHaveLength(0);
  });

  it("sends headers and a sent_at from the clock", async () => {
    const r = await rig();
    await r.core.flush();
    const { req, body } = r.transport.sent[0];
    expect(req.url).toBe("http://ingest.test/v1/batch");
    expect(req.headers).toEqual({ Authorization: "Bearer wk_test_unit", "Content-Type": "application/json", "X-SDK": "js/0.1.0" });
    expect(body.sent_at).toBe(new Date(r.clock.now()).toISOString());
    expect(Object.keys(body)).toEqual(["sent_at", "batch"]);
  });
});

describe("batch assembly", () => {
  it("at most 500 events per request", async () => {
    const r = await rig({ flushAtCount: 10_000 });
    for (let i = 0; i < 1200; i++) r.core.track("t");
    await r.core.flush();
    expect(r.transport.sent.map((s) => s.body.batch.length)).toEqual([500, 500, 202]);
  });

  it("background flushes keep each body under 64 KB", async () => {
    const r = await rig({ flushAtCount: 10_000 });
    for (let i = 0; i < 100; i++) r.core.track("t", { v: "x".repeat(1000) });
    r.lifecycle.fire("background");
    await r.settle();
    expect(r.transport.sent.length).toBeGreaterThan(1);
    for (const s of r.transport.sent) expect(new TextEncoder().encode(s.req.body).length).toBeLessThan(64 * 1024);
    expect(r.transport.events()).toHaveLength(103);
  });

  it("foreground flushes may go up to 1 MB", async () => {
    const r = await rig({ flushAtCount: 10_000 });
    for (let i = 0; i < 100; i++) r.core.track("t", { v: "x".repeat(1000) });
    await r.core.flush();
    expect(r.transport.sent).toHaveLength(1);
  });
});

describe("responses", () => {
  it("202 removes the batch, rejected events included, and logs each rejection", async () => {
    const r = await rig();
    r.transport.script = [{ status: 202, body: { accepted: 1, rejected: [{ index: 1, reason: "duplicate_event_id" }] } }];
    await r.core.flush();
    expect(r.warnings).toEqual(["ipase: the server rejected event 1 ($app_installed): duplicate_event_id"]);
    await r.core.flush();
    expect(r.transport.sent).toHaveLength(1);
  });

  it("400 drops the batch and does not retry", async () => {
    const r = await rig();
    r.transport.script = [{ status: 400, body: { error: "schema_invalid" } }];
    await r.core.flush();
    await r.advance(600_000);
    expect(r.transport.sent).toHaveLength(1);
    expect(r.storage.queue).toHaveLength(0);
  });

  it("401 keeps the queue and stops until the next launch", async () => {
    const r = await rig();
    r.transport.script = [{ status: 401, body: { error: "invalid_key" } }];
    await r.core.flush();
    r.core.track("more");
    await r.core.flush();
    await r.advance(600_000);
    expect(r.transport.sent).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
    const r2 = await r.relaunch();
    await r2.core.flush();
    expect(r2.transport.sent).toHaveLength(2);
    expect(names(r2.transport.events())).toEqual(["session_start", "$app_installed", "more", "$app_foregrounded"]);
  });

  it("413 halves the batch, first half first; a single event that gets 413 is dropped", async () => {
    const r = await rig({ flushAtCount: 100 });
    r.core.track("a");
    r.core.track("b");
    r.transport.script = [{ status: 413 }, { status: 413 }];
    await r.core.flush();
    // The second 413 was on two events, so they were halved again before the second half went.
    expect(r.transport.sent.map((s) => names(s.body.batch))).toEqual([
      ["session_start", "$app_installed", "a", "b"],
      ["session_start", "$app_installed"],
      ["session_start"],
      ["$app_installed"],
      ["a", "b"],
    ]);

    const single = await rig();
    single.transport.script = [{ status: 413 }, { status: 413 }, { status: 413 }];
    await single.core.flush();
    expect(single.transport.sent.map((s) => s.body.batch.length)).toEqual([2, 1, 1]);
    expect(single.warnings).toHaveLength(2);
    expect(single.storage.queue).toHaveLength(0);
  });

  it("429 with Retry-After freezes every trigger for exactly that long, then sends the same events", async () => {
    const r = await rig();
    r.core.track("t");
    r.transport.script = [{ status: 429, retryAfter: 30 }];
    await r.core.flush();
    for (let i = 0; i < 40; i++) r.core.track("t"); // count trigger
    r.lifecycle.fire("background"); // background trigger
    await r.advance(15_000); // interval trigger
    await r.core.flush(); // explicit flush
    await r.advance(14_999);
    expect(r.transport.sent).toHaveLength(1);
    await r.advance(1);
    expect(r.transport.sent.length).toBeGreaterThan(1);
    const first = r.transport.sent[0].body.batch.map((e) => e.event_id);
    const resent = r.transport.events().map((e) => e.event_id);
    expect(resent.slice(0, first.length)).toEqual(first);
  });

  it("5xx and network failures back off 1, 2, 4 ... seconds with jitter, capped at 300", async () => {
    const r = await rig({}, { jitter: 0.5 }); // factor 1.0
    r.transport.script = Array.from({ length: 12 }, (_, i) => ({ status: i % 2 ? 500 : 0 }));
    await r.core.flush();
    const times = [r.clock.now()];
    let last = 1;
    for (let i = 0; i < 12; i++) {
      while (r.transport.sent.length === last) await r.advance(250);
      last = r.transport.sent.length;
      times.push(r.clock.now());
    }
    const gaps = times.slice(1).map((t, i) => (t - times[i]) / 1000);
    expect(gaps.slice(0, 10).map(Math.round)).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 300]);
  });

  it("jitter scales the wait between 0.5 and 1.5", async () => {
    for (const [jitter, wait] of [[0, 500], [0.999, 1499]] as const) {
      const r = await rig({}, { jitter });
      r.transport.script = [{ status: 503 }];
      await r.core.flush();
      await r.advance(wait - 1);
      expect(r.transport.sent).toHaveLength(1);
      await r.advance(2);
      expect(r.transport.sent).toHaveLength(2);
    }
  });

  it("online ends a network-failure wait; it does not end a Retry-After wait", async () => {
    const r = await rig();
    r.transport.script = [{ status: 0 }, { status: 0 }, { status: 0 }];
    await r.core.flush();
    await r.advance(5000);
    const before = r.transport.sent.length;
    r.lifecycle.fire("online");
    await r.settle();
    expect(r.transport.sent.length).toBe(before + 1);

    const q = await rig();
    q.transport.script = [{ status: 429, retryAfter: 60 }];
    await q.core.flush();
    q.lifecycle.fire("online");
    await q.settle();
    expect(q.transport.sent).toHaveLength(1);
  });

  it("a request with no answer after 30 seconds counts as a network failure", async () => {
    const r = await rig();
    let release!: () => void;
    r.transport.send = (req) => {
      r.transport.sent.push({ req, body: JSON.parse(req.body), status: 0 });
      return new Promise((resolve) => (release = () => resolve({ status: 202 })));
    };
    const flushing = r.core.flush();
    await Promise.resolve();
    await new Promise((res) => setTimeout(res, 0));
    await r.clock.advance(30_000);
    await flushing;
    expect(r.storage.queue).toHaveLength(2);
    release();
  });
});

describe("queue capacity", () => {
  it("drops the oldest event beyond maxQueue and reports $events_dropped after the next session_start", async () => {
    const r = await rig({ maxQueue: 5, flushAtCount: 100, sessionTimeoutMs: 1000, consent: "pending" });
    for (let i = 0; i < 6; i++) r.core.track(`t${i}`);
    await r.settle();
    expect(r.storage.queue.map((q) => q.e.name)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(r.storage.state!.dropped).toBe(3);
    await r.advance(5000);
    const r2 = await r.relaunch({ maxQueue: 100 });
    r2.core.optIn();
    await r2.core.flush();
    const events = r2.transport.events();
    expect(names(events).slice(-3)).toEqual(["session_end", "session_start", "$events_dropped"]);
    expect(events.at(-1)!.properties).toEqual({ count: 3 });
    expect(r2.storage.state!.dropped).toBe(0);
  });
});

describe("consent", () => {
  it("pending queues and sends nothing until optIn", async () => {
    const r = await rig({ consent: "pending" });
    r.core.track("a");
    await r.core.flush();
    await r.advance(60_000);
    expect(r.transport.sent).toHaveLength(0);
    r.core.optIn();
    await r.core.flush();
    expect(names(r.transport.events())).toEqual(["session_start", "$app_installed", "a"]);
  });

  it("optOut clears the queue and drops everything after; it is persisted", async () => {
    const r = await rig();
    r.core.track("a");
    r.core.optOut();
    r.core.track("b");
    await r.core.flush();
    expect(r.transport.sent).toHaveLength(0);
    expect(r.storage.queue).toHaveLength(0);
    const r2 = await r.relaunch();
    r2.core.track("c");
    await r2.core.flush();
    expect(r2.transport.sent).toHaveLength(0);
    r2.core.optIn();
    r2.core.track("d");
    await r2.core.flush();
    expect(names(r2.transport.events())).toEqual(["session_start", "d"]);
    expect(r2.transport.events()[0].launch_type).toBe("warm");
  });
});

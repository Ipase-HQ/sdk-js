// Sessions, identity, screens and lifecycle on the virtual clock (protocol 7, 9, 10, 11).
import { describe, expect, it } from "vitest";
import { names, rig } from "../support/fakes";

describe("launch", () => {
  it("a first launch starts a cold session with $app_installed", async () => {
    const r = await rig();
    await r.core.flush();
    const events = r.transport.events();
    expect(names(events)).toEqual(["session_start", "$app_installed"]);
    expect(events[0].launch_type).toBe("cold");
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(events[0].device_id).toBe(r.core.deviceId());
    expect(events[0].session_id).toBe(r.core.sessionId());
    expect(events[0].user_id).toBeUndefined();
  });

  it("a launch within the timeout continues the session with $app_foregrounded", async () => {
    const r1 = await rig();
    const sid = r1.core.sessionId();
    r1.core.track("a");
    await r1.settle();
    await r1.advance(60_000);
    const r2 = await r1.relaunch();
    expect(r2.core.sessionId()).toBe(sid);
    await r2.core.flush();
    const events = r2.transport.events();
    expect(names(events)).toEqual(["session_start", "$app_installed", "a", "$app_foregrounded"]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it("a launch after the timeout closes the dead session backdated to its last activity", async () => {
    const r1 = await rig({ sessionTimeoutMs: 300_000 });
    r1.core.screen("Feed");
    await r1.advance(1000);
    r1.core.track("like");
    await r1.settle();
    const lastLike = r1.clock.now();
    await r1.advance(400_000);
    const r2 = await r1.relaunch();
    await r2.core.flush();
    const events = r2.transport.events();
    expect(names(events)).toEqual(["session_start", "$app_installed", "screen:Feed", "like", "screen_exit", "session_end", "session_start"]);
    const [start, , feed, , exit, end, next] = events;
    expect(exit.timestamp).toBe(new Date(lastLike).toISOString());
    expect(exit.screen).toEqual({ name: "Feed", duration_ms: lastLike - Date.parse(feed.timestamp) });
    expect(end.timestamp).toBe(new Date(lastLike).toISOString());
    expect(end.duration_ms).toBe(lastLike - Date.parse(start.timestamp));
    expect(end.events_count).toBe(end.seq + 1);
    expect(end.screens_viewed).toBe(1);
    expect(next.launch_type).toBe("cold");
    expect(next.session_id).not.toBe(start.session_id);
    expect(next.device_id).toBe(start.device_id);
  });

  it("emits $app_updated on the first session_start after the version changes", async () => {
    const r1 = await rig({ sessionTimeoutMs: 1000 });
    await r1.clock.advance(5000);
    const r2 = await r1.relaunch();
    await r2.core.shutdown();
    await r1.clock.advance(5000);
    const r3 = await (await import("../support/fakes")).rig(
      { sessionTimeoutMs: 1000 },
      { clock: r1.clock, storage: r1.storage, transport: r1.transport, context: { ...r1.context, app: { ...r1.context.app, version: "2.0.0" } } },
    );
    await r3.core.flush();
    const events = r3.transport.events();
    expect(names(events)).toEqual(["session_start", "$app_installed", "session_end", "session_start", "session_end", "session_start", "$app_updated"]);
    expect(events[6].properties).toEqual({ previous_version: "1.0.0", version: "2.0.0" });
  });
});

describe("background and foreground", () => {
  it("background emits screen_exit then $app_backgrounded and flushes", async () => {
    const r = await rig();
    r.core.screen("Home");
    await r.clock.advance(2000);
    r.lifecycle.fire("background");
    await r.settle();
    expect(r.transport.sent).toHaveLength(1);
    const events = r.transport.events();
    expect(names(events)).toEqual(["session_start", "$app_installed", "screen:Home", "screen_exit", "$app_backgrounded"]);
    expect(events[3].screen).toEqual({ name: "Home", duration_ms: 2000 });
  });

  it("foreground within the timeout restarts dwell; a new screen gets previous with zero dwell", async () => {
    const r = await rig({ sessionTimeoutMs: 300_000 });
    r.core.screen("Home");
    r.lifecycle.fire("background");
    await r.advance(299_000);
    r.lifecycle.fire("foreground");
    r.core.screen("Settings");
    await r.advance(3000);
    r.lifecycle.fire("background");
    await r.settle();
    const events = r.transport.events();
    expect(names(events)).toEqual([
      "session_start",
      "$app_installed",
      "screen:Home",
      "screen_exit",
      "$app_backgrounded",
      "$app_foregrounded",
      "screen:Settings",
      "screen_exit",
      "$app_backgrounded",
    ]);
    expect(events[6].screen).toEqual({ name: "Settings", previous: "Home", previous_duration_ms: 0 });
    expect(events[7].screen).toEqual({ name: "Settings", duration_ms: 3000 });
  });

  it("foreground after the timeout ends the session and resumes with the visible screen", async () => {
    const r = await rig({ sessionTimeoutMs: 300_000 });
    r.core.screen("Home");
    r.lifecycle.fire("background");
    await r.settle();
    const lastActivity = r.clock.now();
    await r.advance(301_000);
    r.lifecycle.fire("foreground");
    await r.core.flush();
    const events = r.transport.events();
    expect(names(events).slice(5)).toEqual(["session_end", "session_start", "screen:Home"]);
    expect(events[5].timestamp).toBe(new Date(lastActivity).toISOString());
    expect(events[6].launch_type).toBe("resume");
    expect(events[7].screen).toEqual({ name: "Home" });
    expect(events[7].session_id).toBe(events[6].session_id);
  });

  it("a duplicate background (pagehide after hidden) emits nothing new", async () => {
    const r = await rig();
    r.lifecycle.fire("background");
    r.lifecycle.fire("background");
    await r.settle();
    expect(names(r.transport.events())).toEqual(["session_start", "$app_installed", "$app_backgrounded"]);
  });
});

describe("screens", () => {
  it("previous and dwell within a session; none on the first screen", async () => {
    const r = await rig();
    r.core.screen("A", { tab: "x" });
    await r.clock.advance(1500);
    r.core.screen("B");
    await r.core.flush();
    const [a, b] = r.transport.events().slice(2);
    expect(a.screen).toEqual({ name: "A" });
    expect(a.properties).toEqual({ tab: "x" });
    expect(b.screen).toEqual({ name: "B", previous: "A", previous_duration_ms: 1500 });
  });

  it("a denylisted screen is silent, exits the screen it replaces, and suppresses taps", async () => {
    const r = await rig({ denylistScreens: ["Payment"] });
    r.core.screen("Login");
    r.core.tap({ id: "go", label: "Go", type: "button" });
    await r.clock.advance(1000);
    r.core.screen("Payment");
    r.core.tap({ id: "pay", label: "Pay", type: "button" });
    r.core.track("explicit");
    r.core.screen("Done");
    await r.core.flush();
    const events = r.transport.events();
    expect(names(events)).toEqual(["session_start", "$app_installed", "screen:Login", "$tap", "screen_exit", "explicit", "screen:Done"]);
    expect(events[3].element).toEqual({ id: "go", label: "Go", type: "button", screen: "Login" });
    expect(events[4].screen).toEqual({ name: "Login", duration_ms: 1000 });
    expect(events[6].screen).toEqual({ name: "Done" });
    expect(JSON.stringify(r.transport.sent.map((s) => s.body))).not.toContain("Payment");
  });

  it("auto-captured paths become names with :id and dedupe the same route", async () => {
    const r = await rig();
    r.core.screenAuto("/orders/42");
    r.core.screenAuto("/orders/42");
    r.core.screenAuto("/orders/43");
    await r.core.flush();
    const screens = r.transport.events().filter((e) => e.type === "screen");
    expect(screens.map((e) => e.screen)).toEqual([
      { name: "/orders/:id", route: "/orders/42" },
      { name: "/orders/:id", route: "/orders/43", previous: "/orders/:id", previous_duration_ms: 0 },
    ]);
  });

  it("a tap needs an id or a label; labels are cut to 64 characters", async () => {
    const r = await rig();
    r.core.tap({ type: "button" });
    r.core.tap({ label: "x".repeat(80), type: "a" });
    await r.core.flush();
    const taps = r.transport.events().filter((e) => e.name === "$tap");
    expect(taps).toHaveLength(1);
    expect(taps[0].element).toEqual({ label: "x".repeat(64), type: "a" });
  });
});

describe("identity", () => {
  it("identify stamps user_id until reset; reset ends with it and starts warm without it", async () => {
    const r = await rig();
    r.core.track("before");
    r.core.identify("u_1", { plan: "free" });
    r.core.track("after");
    r.core.screen("Home");
    const device = r.core.deviceId();
    r.core.reset();
    r.core.track("later");
    await r.core.flush();
    const events = r.transport.events();
    expect(names(events)).toEqual(["session_start", "$app_installed", "before", "identify", "after", "screen:Home", "screen_exit", "session_end", "session_start", "screen:Home", "later"]);
    expect(events.map((e) => e.user_id)).toEqual([undefined, undefined, undefined, "u_1", "u_1", "u_1", "u_1", "u_1", undefined, undefined, undefined]);
    expect(events[3].traits).toEqual({ plan: "free" });
    expect(events[8].launch_type).toBe("warm");
    expect(events[9].screen).toEqual({ name: "Home" });
    expect(new Set(events.map((e) => e.device_id))).toEqual(new Set([device]));
    expect(events[7].events_count).toBe(8);
  });

  it("user_id survives a relaunch", async () => {
    const r1 = await rig();
    r1.core.identify("u_9");
    await r1.settle();
    const r2 = await r1.relaunch();
    r2.core.track("x");
    await r2.core.flush();
    expect(r2.transport.events().at(-1)!.user_id).toBe("u_9");
  });
});

describe("refusals", () => {
  it("are reported through the log hook and never queued; seq stays contiguous", async () => {
    const r = await rig();
    r.core.track("$checkout");
    r.core.track("up", { $plan: "pro" });
    r.core.identify("");
    r.core.screen("");
    r.core.track("big", { a: "x".repeat(1000), ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "y".repeat(1000)])) });
    r.core.track("fine");
    await r.core.flush();
    expect(r.refusals).toEqual([
      { reason: "reserved_name", name: "$checkout" },
      { reason: "reserved_property_key", name: "up" },
      { reason: "invalid_user_id", name: "identify" },
      { reason: "invalid_name", name: "" },
      { reason: "event_too_large", name: "big" },
    ]);
    const events = r.transport.events();
    expect(names(events)).toEqual(["session_start", "$app_installed", "fine"]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

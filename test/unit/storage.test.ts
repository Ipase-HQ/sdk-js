// @vitest-environment happy-dom
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { browserStorage } from "../../src/browser/storage";
import type { PersistedState } from "../../src/core/ports";

const state = (deviceId: string): PersistedState => ({ v: 1, deviceId, dropped: 0, consent: "granted", nextKey: 3 });
const event = (k: number) => ({ k, e: { event_id: `e${k}` } as never });

beforeEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  localStorage.clear();
});

async function roundTrip() {
  const s = browserStorage("wk_test");
  await s.saveState(state("d1"));
  await s.append([event(2), event(1), event(3)]);
  await s.remove([2]);
  const loaded = await browserStorage("wk_test").load();
  expect(loaded.state).toEqual(state("d1"));
  expect(loaded.queue.map((q) => q.k)).toEqual([1, 3]);
  await s.clearQueue();
  expect((await browserStorage("wk_test").load()).queue).toEqual([]);
}

describe("browserStorage", () => {
  it("IndexedDB keeps state and queue order across instances", roundTrip);

  it("falls back to localStorage without IndexedDB", async () => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    await roundTrip();
    expect(localStorage.getItem("ipase:wk_test:state")).toContain("d1");
  });

  it("mirrors the device id so it survives IndexedDB being cleared", async () => {
    await browserStorage("wk_test").saveState(state("d-mirror"));
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    const loaded = await browserStorage("wk_test").load();
    expect(loaded.state).toBeUndefined();
    expect(loaded.deviceId).toBe("d-mirror");
  });

  it("keeps projects apart by write key", async () => {
    await browserStorage("wk_a").append([event(1)]);
    expect((await browserStorage("wk_b").load()).queue).toEqual([]);
  });
});

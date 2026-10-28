import { describe, expect, it } from "vitest";
import { screenNameFromPath } from "../../src/core/client";
import { uuid4, uuid7 } from "../../src/core/uuid";

const random = () => crypto.getRandomValues(new Uint8Array(16));

describe("ids", () => {
  it("uuid4 is a lowercase v4", () => {
    for (let i = 0; i < 50; i++) expect(uuid4(random())).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("uuid7 carries the millisecond timestamp, version 7 and the RFC 9562 variant", () => {
    const ms = Date.parse("2026-10-28T10:00:00.123Z");
    const id = uuid7(ms, random());
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(ms);
  });

  it("screen names replace numeric and uuid segments", () => {
    expect(screenNameFromPath("/")).toBe("/");
    expect(screenNameFromPath("/orders/123/items")).toBe("/orders/:id/items");
    expect(screenNameFromPath("/u/0193a5e2-7c1d-7b4e-9f00-1234567890ab")).toBe("/u/:id");
    expect(screenNameFromPath("/v2/about")).toBe("/v2/about");
  });
});

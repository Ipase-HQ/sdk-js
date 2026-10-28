import { describe, expect, it } from "vitest";
import { checkName, checkProperties, checkUserId, utf8Length } from "../../src/core/validate";

const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));

describe("local validation (protocol 15)", () => {
  it("names", () => {
    expect(checkName("ok")).toBeUndefined();
    expect(checkName("")).toBe("invalid_name");
    expect(checkName("x".repeat(129))).toBe("invalid_name");
    expect(checkName("x".repeat(128))).toBeUndefined();
    expect(checkName("$checkout")).toBe("reserved_name");
    expect(checkName("$tap", false)).toBeUndefined();
  });

  it("user ids", () => {
    expect(checkUserId("u_1")).toBeUndefined();
    expect(checkUserId("")).toBe("invalid_user_id");
    expect(checkUserId("x".repeat(129))).toBe("invalid_user_id");
  });

  it("properties", () => {
    expect(checkProperties(undefined)).toBeUndefined();
    expect(checkProperties(keys(100))).toBeUndefined();
    expect(checkProperties(keys(101))).toBe("properties_too_many");
    expect(checkProperties({ $plan: "pro" })).toBe("reserved_property_key");
    expect(checkProperties({ ["k".repeat(65)]: 1 })).toBe("property_key_too_long");
    expect(checkProperties({ "": 1 })).toBe("property_key_too_long");
    expect(checkProperties({ a: "x".repeat(1025) })).toBe("property_value_too_long");
    expect(checkProperties({ a: "x".repeat(1024), b: 1.5, c: true, d: null })).toBeUndefined();
    expect(checkProperties({ a: NaN })).toBe("invalid_property");
    expect(checkProperties({ a: Infinity })).toBe("invalid_property");
    expect(checkProperties({ a: { nested: 1 } })).toBe("invalid_property");
    expect(checkProperties({ a: [1] })).toBe("invalid_property");
    expect(checkProperties({ a: undefined })).toBe("invalid_property");
    expect(checkProperties([1, 2])).toBe("invalid_property");
  });

  it("utf8Length matches TextEncoder", () => {
    for (const s of ["", "abc", "é", "日本語", "😀x", "a\u0000b"]) expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
  });
});

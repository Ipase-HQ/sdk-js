import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SDK_VERSION, SPEC_VERSION } from "../../src/version";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

describe("version constants", () => {
  it("match package.json", () => {
    expect(SDK_VERSION).toBe(pkg.version);
    expect(SPEC_VERSION).toBe(pkg.ipase.spec);
  });
});

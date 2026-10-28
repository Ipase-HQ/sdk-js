import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { gzip, storedGzip } from "../../src/browser/gzip";

describe("gzip", () => {
  it("the stored fallback is valid gzip for empty, small and multi-block input", () => {
    for (const size of [0, 10, 65535, 65536, 200_000]) {
      const data = new Uint8Array(size).map((_, i) => (i * 31) & 0xff);
      expect(new Uint8Array(gunzipSync(storedGzip(data)))).toEqual(data);
    }
  });

  it("CompressionStream output decodes to the input", async () => {
    const text = JSON.stringify({ batch: Array.from({ length: 50 }, (_, i) => ({ i, name: "é日本" })) });
    expect(gunzipSync(await gzip(text)).toString("utf8")).toBe(text);
  });
});

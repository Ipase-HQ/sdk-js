import { defineConfig } from "vitest/config";

// Conformance: every sdk-spec fixture that lists js, driven against the real browser adapters in
// happy-dom with fake-indexeddb and a virtual clock, sending real requests to the mock server.
export default defineConfig({
  test: {
    include: ["test/conformance/**/*.test.ts"],
    environment: "happy-dom",
    globalSetup: ["test/conformance/mock-server.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});

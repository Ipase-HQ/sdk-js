import { defineConfig } from "vitest/config";

// Conformance: every sdk-spec fixture that lists js, driven against the real browser adapters in
// happy-dom with fake-indexeddb and a virtual clock, sending real requests to the mock server.
export default defineConfig({
  test: {
    include: ["test/conformance/**/*.test.ts"],
    environment: "happy-dom",
    // The mock server answers no CORS preflight; a production ingest does. happy-dom's fetch is
    // still the one the SDK uses, so requests go through a browser fetch implementation.
    environmentOptions: { happyDOM: { settings: { fetch: { disableSameOriginPolicy: true } } } },
    globalSetup: ["test/conformance/mock-server.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});

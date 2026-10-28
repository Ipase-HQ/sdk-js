import { defineConfig } from "vitest/config";

// Unit tests. The core runs in plain node; browser adapter tests opt into happy-dom per file.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
  },
});

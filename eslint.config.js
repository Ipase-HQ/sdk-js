import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/", "test/conformance/.fixtures/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // The SDK ships zero runtime dependencies: src may only import from src.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ regex: "^[^.]", message: "src must not import packages (zero runtime dependencies)" }] }],
      "no-console": ["error", { allow: ["warn"] }],
    },
  },
);

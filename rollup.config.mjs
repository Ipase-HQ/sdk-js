// ESM and UMD builds of the public API, ES2019, minified. Types come from tsc (tsconfig.build.json).
import esbuild from "rollup-plugin-esbuild";

export default {
  input: "src/index.ts",
  plugins: [esbuild({ target: "es2019", minify: true, legalComments: "none" })],
  output: [
    { file: "dist/ipase.mjs", format: "es", sourcemap: true },
    { file: "dist/ipase.umd.js", format: "umd", name: "Ipase", sourcemap: true },
  ],
};

// Vitest globalSetup for conformance. With MOCK_SERVER_URL set (CI, where the image runs as a
// container) it only checks that server; otherwise it starts ../sdk-spec/mock-server on a free port.
// Either way the server must report the spec version this SDK declares.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { SPEC_VERSION } from "../../src/version";

declare module "vitest" {
  export interface ProvidedContext {
    mockServer: string;
  }
}

const specDir = fileURLToPath(new URL("../../../sdk-spec/", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function health(url: string, attempts: number): Promise<{ spec_version: string }> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${url}/__health`);
      if (res.ok) return await res.json();
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`mock server at ${url} is not healthy: ${String(last)}`);
}

export default async function setup(project: TestProject): Promise<() => void> {
  let url = process.env.MOCK_SERVER_URL?.replace(/\/+$/, "");
  let child: ChildProcess | undefined;
  if (!url) {
    // The compiled server needs only node, so it runs whatever architecture its esbuild was built for.
    const serverDir = `${specDir}mock-server/`;
    const cli = `${serverDir}dist/cli.js`;
    if (!existsSync(cli)) throw new Error(`build the mock server first (cd ${serverDir} && npm install && npm run build), or set MOCK_SERVER_URL`);
    const newest = (dir: string) => Math.max(...readdirSync(dir).map((f) => statSync(`${dir}/${f}`).mtimeMs));
    if (newest(`${serverDir}src`) > newest(`${serverDir}dist`)) throw new Error(`${serverDir}dist is older than its src: run npm run build there`);
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [cli], { cwd: serverDir, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" }, stdio: ["ignore", "ignore", "inherit"] });
  }
  const info = await health(url, 80);
  if (info.spec_version !== SPEC_VERSION) throw new Error(`mock server speaks spec ${info.spec_version}, this SDK declares ${SPEC_VERSION}`);
  project.provide("mockServer", url);
  return () => {
    if (child) child.kill("SIGTERM");
  };
}

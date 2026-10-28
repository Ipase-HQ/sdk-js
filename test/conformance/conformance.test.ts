// Conformance runner (sdk-spec/fixtures/README.md, "The harness contract"). Every fixture that lists
// js is driven step by step against the real browser adapters (happy-dom, fake-indexeddb, real
// fetch to the mock server) on a virtual clock, then judged by POST /__verify. The runner never
// evaluates `expect` itself.

import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { createInstance, type Instance, type Options } from "../../src/browser/client";
import type { Refusal } from "../../src/core/ports";
import { VirtualClock } from "../support/virtual-clock";

const server = inject("mockServer");
// Locally the sibling sdk-spec checkout; in CI the fixtures copied out of the mock server image.
const fixturesDir = resolve(process.env.FIXTURES_DIR || "../sdk-spec/fixtures");
const WRITE_KEY = "wk_test_conformance";

interface Step {
  action: string;
  [field: string]: any;
}
interface Fixture {
  id: string;
  platforms: string[];
  config?: Record<string, unknown>;
  steps: Step[];
}

const fixtures: Fixture[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json") && f !== "scenario.schema.json")
  .map((f) => JSON.parse(readFileSync(`${fixturesDir}/${f}`, "utf8")))
  .filter((f: Fixture) => f.platforms.includes("js"));

/** Fixture config keys are the protocol's names; init options are camelCase, with these renames. */
function options(config: Record<string, unknown> = {}): Options {
  const renames: Record<string, keyof Options> = { session_timeout_seconds: "sessionTimeout", denylist_screens: "denylistScreens", flush_at: "flushAt", flush_interval_seconds: "flushInterval", max_queue: "maxQueue" };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) out[renames[key] || key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = value;
  return out as Options;
}

// Control calls (/__scenario, /__recorded, /__verify) are harness traffic, not SDK traffic, so they
// go through node:http instead of happy-dom's fetch. Only the SDK's own requests meet browser CORS.
function control(method: string, path: string, body?: unknown): Promise<any> {
  return new Promise((done, fail) => {
    const req = request(`${server}${path}`, { method, headers: { "content-type": "application/json" } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => {
        const json = JSON.parse(text);
        if ((res.statusCode ?? 0) >= 400) fail(new Error(`${path} answered ${res.statusCode}: ${text}`));
        else done(json);
      });
    });
    req.on("error", fail);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const post = (path: string, body: unknown): Promise<any> => control("POST", path, body);

// The network step toggles this wrapper; the SDK's fetch adapter reads globalThis.fetch per call.
const realFetch = globalThis.fetch.bind(globalThis);
let online = true;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  online ? realFetch(input, init) : Promise.reject(new TypeError("Failed to fetch (offline)"))) as typeof fetch;

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
Object.defineProperty(document, "hidden", { configurable: true, get: () => visibility === "hidden" });

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

class Harness {
  readonly clock = new VirtualClock();
  readonly warnings: Refusal[] = [];
  instance: Instance | undefined;

  constructor(readonly fixture: Fixture) {}

  private get core() {
    if (!this.instance) throw new Error("step needs a launched SDK");
    return this.instance.core;
  }

  settle = async (): Promise<void> => {
    if (this.instance) await this.instance.core.settled();
  };

  async run(step: Step): Promise<void> {
    const repeat = step.repeat ?? 1;
    switch (step.action) {
      case "launch":
        this.instance = createInstance(
          WRITE_KEY,
          {
            ...options(this.fixture.config),
            endpoint: server,
            appName: "Conformance",
            appVersion: "1.0.0",
            // Fixture screen names ("Login") are not pathnames, and an initial-load screen would be
            // an entry screen no fixture expects, so screens are driven through screen(name).
            autocapture: { screens: false, taps: true },
            clock: this.clock,
            logHook: (r) => this.warnings.push(r),
          },
          window,
        );
        break;
      case "kill_process":
        await this.settle();
        await this.instance?.stop();
        this.instance = undefined;
        break;
      case "wait_ms":
        await this.clock.advance(step.value, this.settle);
        break;
      case "network":
        online = step.state === "online";
        window.dispatchEvent(new Event(online ? "online" : "offline"));
        break;
      case "screen":
        this.core.screen(step.name);
        break;
      case "track": {
        const props = step.property_count !== undefined ? Object.fromEntries(Array.from({ length: step.property_count }, (_, i) => [`k${i}`, i])) : step.properties;
        for (let i = 0; i < repeat; i++) this.core.track(step.name, props);
        break;
      }
      case "tap":
        for (let i = 0; i < repeat; i++) {
          const button = document.createElement("button");
          if (step.element_id) button.setAttribute("data-monitor-id", step.element_id);
          if (step.label) button.textContent = step.label;
          document.body.appendChild(button);
          button.click();
          button.remove();
        }
        break;
      case "type_text": {
        const input = document.createElement("input");
        input.name = input.id = step.field;
        input.type = /password/i.test(step.field) ? "password" : "text";
        document.body.appendChild(input);
        input.focus();
        input.click();
        for (const ch of String(step.value)) {
          input.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
          input.value += ch;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
        }
        input.dispatchEvent(new Event("change", { bubbles: true }));
        break;
      }
      case "identify":
        this.core.identify(step.user_id, step.traits);
        break;
      case "reset":
        this.core.reset();
        break;
      case "background":
        setVisibility("hidden");
        break;
      case "foreground":
        setVisibility("visible");
        break;
      case "flush":
        await this.core.flush();
        break;
      case "assert_requests": {
        await this.settle();
        const recorded = await control("GET", "/__recorded");
        if (recorded.requests.length !== step.count) {
          const summary = recorded.requests.map((r: any) => `${r.response.status}:${r.events?.length ?? 0} events`);
          throw new Error(`assert_requests: expected ${step.count} requests, the mock server recorded ${recorded.requests.length} [${summary.join(", ")}]`);
        }
        break;
      }
      default:
        throw new Error(`unknown step action ${step.action}`);
    }
    await this.settle();
  }
}

let current: Harness | undefined;

afterEach(async () => {
  await current?.instance?.stop();
  current = undefined;
});

describe("sdk-spec fixtures", () => {
  it("found fixtures that list js", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(fixture.id, async () => {
      // A fresh install: no persisted device id, session, queue or consent.
      (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
      localStorage.clear();
      document.body.innerHTML = "";
      online = true;
      visibility = "visible";

      await post("/__scenario", fixture);
      const harness = (current = new Harness(fixture));
      for (const [i, step] of fixture.steps.entries()) {
        try {
          await harness.run(step);
        } catch (err) {
          (err as Error).message = `step ${i} (${step.action}): ${(err as Error).message}`;
          throw err;
        }
      }
      const verdict = await post("/__verify", { fixture: fixture.id, local: { warnings: harness.warnings } });
      if (!verdict.pass) console.error(`${fixture.id} failures:\n${JSON.stringify(verdict.failures, null, 2)}`);
      expect(verdict.failures).toEqual([]);
      expect(verdict.pass).toBe(true);
    });
  }
});

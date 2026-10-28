// Wires the core to the browser adapters. The public module (src/index.ts) holds one instance;
// the conformance harness creates and discards instances directly.

import { Core } from "../core/client";
import type { Clock, Ids, Logger, Refusal } from "../core/ports";
import type { Autocapture, Consent } from "../core/types";
import { uuid4, uuid7 } from "../core/uuid";
import { DEFAULT_ENDPOINT } from "../version";
import { autocapture } from "./autocapture";
import { collectContext } from "./context";
import { browserLifecycle } from "./lifecycle";
import { browserStorage } from "./storage";
import { fetchTransport } from "./transport";

export interface Options {
  /** Ingest origin, for example https://in.example.com. /v1/batch is appended. */
  endpoint?: string;
  /** context.app.name. Defaults to the page's hostname. */
  appName?: string;
  /** context.app.version. Under Electron, pass app.getVersion(). */
  appVersion?: string;
  /** context.app.bundle_id under Electron. Defaults to location.origin. */
  bundleId?: string;
  /** Seconds between flushes while the queue is not empty. Default 15. */
  flushInterval?: number;
  /** Queued events that trigger a flush. Default 30. */
  flushAt?: number;
  /** Queue capacity; the oldest event is dropped beyond it. Default 10,000. */
  maxQueue?: number;
  /** Seconds in the background before the session ends. Default 1800. */
  sessionTimeout?: number;
  /** true, false or { screens, taps }. Default both on. */
  autocapture?: boolean | Autocapture;
  /** Initial consent when none is persisted. Default granted. */
  consent?: Consent;
  /** Screen names that are visible but silent. */
  denylistScreens?: string[];
  /** Test hook: replaces the wall clock and timers (protocol 17). */
  clock?: Clock;
  /** Test hook: receives every local refusal (protocol 15 and 17). */
  logHook?: (refusal: Refusal) => void;
}

export interface Instance {
  core: Core;
  /** Removes listeners and timers without flushing; storage is kept. */
  stop(): Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function cryptoIds(): Ids {
  const bytes = () => crypto.getRandomValues(new Uint8Array(16));
  return {
    uuid4: () => uuid4(bytes()),
    uuid7: (ms) => uuid7(ms, bytes()),
    random: () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296,
  };
}

const num = (value: number | undefined, fallback: number) => (typeof value === "number" && value >= 0 && isFinite(value) ? value : fallback);

export function createInstance(writeKey: string, options: Options = {}, win: Window = window): Instance {
  const hook = options.logHook;
  const logger: Logger = {
    warn: (message) => console.warn(message),
    refused(r) {
      console.warn(`ipase: refused "${r.name}": ${r.reason}`);
      if (hook) hook(r);
    },
  };
  const capture = options.autocapture;
  const auto = { screens: capture !== false, taps: capture !== false };
  if (capture && typeof capture === "object") {
    auto.screens = capture.screens !== false;
    auto.taps = capture.taps !== false;
  }
  const core = new Core(
    {
      writeKey,
      endpoint: (options.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, ""),
      flushAtCount: Math.max(1, num(options.flushAt, 30)),
      flushIntervalMs: num(options.flushInterval, 15) * 1000,
      maxQueue: Math.max(1, num(options.maxQueue, 10_000)),
      sessionTimeoutMs: num(options.sessionTimeout, 1800) * 1000,
      consent: options.consent || "granted",
      denylistScreens: options.denylistScreens || [],
    },
    {
      clock: options.clock || realClock,
      storage: browserStorage(writeKey),
      transport: fetchTransport(),
      lifecycle: browserLifecycle(win),
      ids: cryptoIds(),
      logger,
      context: collectContext(win, options),
    },
  );
  const detach = autocapture(win, core, auto);
  return {
    core,
    stop() {
      detach();
      return core.shutdown();
    },
  };
}

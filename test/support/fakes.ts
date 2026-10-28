// In-memory ports for core unit tests.

import { Core, type Deps } from "../../src/core/client";
import type { Lifecycle, LifecycleEvent, Loaded, PersistedState, QueuedEvent, Refusal, Storage, Transport, TransportRequest, TransportResponse } from "../../src/core/ports";
import type { Config, Context, WireEvent } from "../../src/core/types";
import { uuid4, uuid7 } from "../../src/core/uuid";
import { VirtualClock } from "./virtual-clock";

export class MemoryStorage implements Storage {
  state: PersistedState | undefined;
  queue: QueuedEvent[] = [];
  /** Operations in order, for asserting persist-before-send. */
  log: string[] = [];

  async load(): Promise<Loaded> {
    return { state: this.state && JSON.parse(JSON.stringify(this.state)), queue: JSON.parse(JSON.stringify(this.queue)) };
  }
  async saveState(state: PersistedState): Promise<void> {
    this.state = JSON.parse(JSON.stringify(state));
  }
  async append(items: QueuedEvent[]): Promise<void> {
    this.log.push(`append:${items.length}`);
    this.queue.push(...JSON.parse(JSON.stringify(items)));
  }
  async remove(keys: number[]): Promise<void> {
    this.queue = this.queue.filter((q) => keys.indexOf(q.k) < 0);
  }
  async clearQueue(): Promise<void> {
    this.queue = [];
  }
}

export interface Sent {
  req: TransportRequest;
  body: { sent_at: string; batch: WireEvent[] };
  status: number;
}

/** Answers from a script, then 202. A response of status 0 is a network failure. */
export class ScriptedTransport implements Transport {
  script: TransportResponse[] = [];
  sent: Sent[] = [];
  storage?: MemoryStorage;

  async send(req: TransportRequest): Promise<TransportResponse> {
    if (this.storage) this.storage.log.push("send");
    const res = this.script.shift() || { status: 202, body: { accepted: 0, rejected: [] } };
    this.sent.push({ req, body: JSON.parse(req.body), status: res.status });
    return res;
  }

  events(status = 202): WireEvent[] {
    return this.sent.filter((s) => s.status === status).flatMap((s) => s.body.batch);
  }
}

export class FakeLifecycle implements Lifecycle {
  visible = true;
  private listeners: Array<(e: LifecycleEvent) => void> = [];
  isForeground(): boolean {
    return this.visible;
  }
  subscribe(listener: (e: LifecycleEvent) => void): () => void {
    this.listeners.push(listener);
    return () => (this.listeners = this.listeners.filter((l) => l !== listener));
  }
  fire(e: LifecycleEvent): void {
    if (e === "background") this.visible = false;
    if (e === "foreground") this.visible = true;
    this.listeners.forEach((l) => l(e));
  }
}

export const CONTEXT: Context = {
  platform: "web",
  app: { name: "Test", version: "1.0.0", bundle_id: "https://app.test" },
  os: { name: "macOS", version: "15.1" },
  browser: { name: "Chrome", version: "130" },
  locale: "en-GB",
  timezone: "Europe/London",
  sdk: { name: "js", version: "0.1.0", spec: "1.0.0-draft.3" },
};

/** Deterministic Ids: seeded bytes, and a fixed jitter factor unless overridden. */
export function seededIds(jitter = 0.5) {
  let n = 0;
  const bytes = () => {
    const b = new Uint8Array(16);
    let x = ++n * 2654435761;
    for (let i = 0; i < 16; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      b[i] = x & 0xff;
    }
    return b;
  };
  return { uuid4: () => uuid4(bytes()), uuid7: (ms: number) => uuid7(ms, bytes()), random: () => jitter };
}

export interface Rig {
  core: Core;
  clock: VirtualClock;
  storage: MemoryStorage;
  transport: ScriptedTransport;
  lifecycle: FakeLifecycle;
  refusals: Refusal[];
  warnings: string[];
  settle(): Promise<void>;
  advance(ms: number): Promise<void>;
  /** Discard the instance without flushing and launch a new one on the same storage. */
  relaunch(cfg?: Partial<Config>): Promise<Rig>;
  context: Context;
}

export const DEFAULTS: Config = {
  writeKey: "wk_test_unit",
  endpoint: "http://ingest.test",
  flushAtCount: 30,
  flushIntervalMs: 15_000,
  maxQueue: 10_000,
  sessionTimeoutMs: 1_800_000,
  consent: "granted",
  denylistScreens: [],
};

export async function rig(
  cfg: Partial<Config> = {},
  shared: { clock?: VirtualClock; storage?: MemoryStorage; transport?: ScriptedTransport; context?: Context; jitter?: number } = {},
): Promise<Rig> {
  const clock = shared.clock || new VirtualClock();
  const storage = shared.storage || new MemoryStorage();
  const transport = shared.transport || new ScriptedTransport();
  transport.storage = storage;
  const lifecycle = new FakeLifecycle();
  const refusals: Refusal[] = [];
  const warnings: string[] = [];
  const context = shared.context || CONTEXT;
  const deps: Deps = {
    clock,
    storage,
    transport,
    lifecycle,
    ids: seededIds(shared.jitter),
    logger: { warn: (m) => warnings.push(m), refused: (r) => refusals.push(r) },
    context,
  };
  const core = new Core({ ...DEFAULTS, ...cfg }, deps);
  const settle = () => core.settled();
  await settle();
  const r: Rig = {
    core,
    clock,
    storage,
    transport,
    lifecycle,
    refusals,
    warnings,
    context,
    settle,
    advance: (ms) => clock.advance(ms, settle),
    async relaunch(next = {}) {
      await core.shutdown();
      return rig({ ...cfg, ...next }, { clock, storage, transport, context });
    },
  };
  return r;
}

export const names = (events: WireEvent[]) => events.map((e) => (e.type === "track" ? e.name : e.type === "screen" ? `screen:${e.screen!.name}` : e.type));

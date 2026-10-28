// The platform-agnostic core: sessions, identity, consent, local validation, auto-capture event
// shaping, the persisted queue, batching, and the retry rules of protocol sections 3 and 4. It
// reaches the outside world only through the ports in ./ports.

import type { Clock, Ids, Lifecycle, LifecycleEvent, Loaded, Logger, PersistedState, QueuedEvent, ScreenState, Storage, Transport, TransportResponse } from "./ports";
import type { Config, Context, Element, LaunchType, Properties, Screen, WireEvent } from "./types";
import { MAX_EVENT_BYTES, checkName, checkProperties, checkUserId, utf8Length, type Reason } from "./validate";
import { SDK_NAME, SDK_VERSION } from "../version";

export interface Deps {
  clock: Clock;
  storage: Storage;
  transport: Transport;
  lifecycle: Lifecycle;
  ids: Ids;
  logger: Logger;
  context: Context;
}

/** A queued event with its serialized form and UTF-8 size, kept in memory only. */
interface Item extends QueuedEvent {
  j: string;
  n: number;
}

type Fields = Omit<WireEvent, "event_id" | "device_id" | "session_id" | "seq" | "timestamp" | "context">;

const BATCH_MAX_EVENTS = 500;
/** Envelope bytes around the events: sent_at, the brackets and a margin for gzip framing. */
const ENVELOPE_BYTES = 1024;
const BODY_MAX_BYTES = 1024 * 1024;
/** Browsers cap keepalive bodies at 64 KB; background flushes stay under it (ADR 0005). */
const BACKGROUND_BODY_MAX_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

/** Pathname to screen name (protocol 14): numeric and UUID segments become :id. */
export function screenNameFromPath(path: string): string {
  return path
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ? ":id" : seg))
    .join("/");
}

function exitScreen(sc: ScreenState, at: number): Screen {
  const screen: Screen = { name: sc.name, duration_ms: Math.max(0, at - sc.shownAt) };
  if (sc.route !== undefined) screen.route = sc.route;
  return screen;
}

function errorCode(body: unknown): string {
  return body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
}

/** Shallow copy of a plain object so later mutation by the host app cannot change a queued event. */
function copy<T>(value: T): T {
  return value && typeof value === "object" && !Array.isArray(value) ? ({ ...value } as T) : value;
}

export class Core {
  private state!: PersistedState;
  private queue: Item[] = [];
  private ready = false;
  private pending: Array<() => void> = [];
  private readonly loaded: Promise<void>;
  private foreground: boolean;
  private dead = false;
  private readonly denylist: { [name: string]: true } = {};
  private readonly unsubscribe: () => void;

  // Persistence: mutations made in one tick are written together, in order, before any send.
  private writes: Promise<void> = Promise.resolve();
  private saveScheduled = false;
  private toAppend: QueuedEvent[] = [];
  private toRemove: number[] = [];
  private clearAll = false;
  private storageWarned = false;

  // Sending (protocol 4): one request in flight, a wait freezes every trigger.
  private draining: Promise<void> | undefined;
  private readonly inflight: { [key: number]: true } = {};
  private waitTimer: unknown;
  private waitIsNetwork = false;
  private attempts = 0;
  private stopped = false;
  private intervalTimer: unknown;
  private splits: number[][] = [];

  constructor(
    private readonly cfg: Config,
    private readonly d: Deps,
  ) {
    for (const name of cfg.denylistScreens) this.denylist[name] = true;
    this.foreground = d.lifecycle.isForeground();
    this.unsubscribe = d.lifecycle.subscribe((e) => this.run(() => this.onLifecycle(e)));
    this.loaded = d.storage
      .load()
      .catch((err): Loaded => {
        this.storageFailed(err);
        return { queue: [] };
      })
      .then((loaded) => {
        if (this.dead) return;
        this.launch(loaded);
        this.ready = true;
        const pending = this.pending;
        this.pending = [];
        for (const fn of pending) fn();
      });
  }

  // ---- public API ---------------------------------------------------------------------------

  screen(name: string, properties?: Properties): void {
    const props = copy(properties);
    this.run(() => this.showScreen(name, props));
  }

  /** Auto-capture: the page now shows this pathname (initial load or History API). */
  screenAuto(path: string): void {
    this.run(() => {
      const sc = this.state.screen;
      const s = this.state.session;
      if (sc && s && sc.route === path && sc.sid === s.id) return;
      this.showScreen(screenNameFromPath(path), undefined, path.length <= 512 ? path : undefined);
    });
  }

  track(name: string, properties?: Properties): void {
    const props = copy(properties);
    this.run(() => {
      const reason = checkName(name) || checkProperties(props);
      if (reason) return this.refuse(reason, name);
      const fields: Fields = { type: "track", name };
      if (props) fields.properties = props;
      this.emit(fields);
    });
  }

  /** Auto-capture: a click on a control. The adapter never reads text field values. */
  tap(el: Element): void {
    this.run(() => {
      const sc = this.state.screen;
      if (sc && sc.denylisted) return;
      const element: Element = {};
      if (el.id && el.id.length <= 128) element.id = el.id;
      if (el.label) element.label = el.label.slice(0, 64);
      if (!element.id && !element.label) return;
      if (el.type && el.type.length <= 32) element.type = el.type;
      if (sc) element.screen = sc.name;
      this.emit({ type: "track", name: "$tap", element });
    });
  }

  identify(userId: string, traits?: Properties): void {
    const props = copy(traits);
    this.run(() => {
      const reason = checkUserId(userId) || checkProperties(props);
      if (reason) return this.refuse(reason, "identify");
      this.state.userId = userId;
      const fields: Fields = { type: "identify", user_id: userId };
      if (props) fields.traits = props;
      this.emit(fields);
      this.save();
    });
  }

  reset(): void {
    this.run(() => {
      if (this.state.session) this.endSession(this.d.clock.now());
      this.state.userId = undefined;
      this.startSession("warm");
      this.save();
    });
  }

  optIn(): void {
    this.run(() => {
      const was = this.state.consent;
      this.state.consent = "granted";
      // Nothing of the current session left the device while denied, so start a fresh one.
      if (was === "denied") this.startSession("warm");
      this.save();
      this.armInterval();
      if (this.queue.length >= this.cfg.flushAtCount) this.drain();
    });
  }

  optOut(): void {
    this.run(() => {
      this.state.consent = "denied";
      this.queue = [];
      this.splits = [];
      this.clearAll = true;
      this.toAppend = [];
      this.toRemove = [];
      this.save();
    });
  }

  /** Sends everything queued and resolves when no request is in flight. */
  async flush(): Promise<void> {
    await this.loaded;
    if (this.draining) await this.draining;
    await this.drain();
  }

  deviceId(): string | undefined {
    return this.ready ? this.state.deviceId : undefined;
  }

  sessionId(): string | undefined {
    return this.ready && this.state.session ? this.state.session.id : undefined;
  }

  /** Stops timers and listeners, keeps storage, sends nothing more. The instance is unusable after. */
  async shutdown(): Promise<void> {
    this.dead = true;
    this.unsubscribe();
    this.d.clock.clearTimeout(this.waitTimer);
    this.d.clock.clearTimeout(this.intervalTimer);
    await this.loaded;
    await this.writes;
    if (this.d.storage.close) this.d.storage.close();
  }

  /** Resolves once loading, every pending write and every request has finished. For harnesses. */
  async settled(): Promise<void> {
    await this.loaded;
    for (;;) {
      const draining = this.draining;
      await this.writes;
      if (draining) await draining;
      if (!this.saveScheduled && !this.draining) return;
    }
  }

  // ---- sessions, screens and lifecycle (protocol 9 and 10) ----------------------------------

  private run(fn: () => void): void {
    if (this.dead) return;
    if (this.ready) fn();
    else this.pending.push(fn);
  }

  private launch(loaded: Loaded): void {
    const now = this.d.clock.now();
    const st = loaded.state;
    this.state =
      st && st.v === 1
        ? st
        : { v: 1, deviceId: loaded.deviceId || this.d.ids.uuid4(), installPending: !loaded.deviceId, dropped: 0, consent: this.cfg.consent, nextKey: 1 };
    this.queue = loaded.queue.map((q) => this.item(q)).sort((a, b) => a.k - b.k);
    for (const q of this.queue) if (q.k >= this.state.nextKey) this.state.nextKey = q.k + 1;

    const s = this.state.session;
    if (s && now - s.lastActivity <= this.cfg.sessionTimeoutMs) {
      if (this.foreground) this.continueSession();
    } else {
      if (s) this.endSession(s.lastActivity);
      // A page load shows a new page: the entry screen comes from auto-capture or screen().
      this.state.screen = undefined;
      this.startSession("cold");
    }
    this.save();
    this.armInterval();
  }

  private onLifecycle(e: LifecycleEvent): void {
    if (e === "background") this.toBackground();
    else if (e === "foreground") this.toForeground();
    else if (e === "online" && this.waitTimer !== undefined && this.waitIsNetwork) {
      // The network is back: a wait caused by a network failure ends now. Retry-After waits stay.
      this.d.clock.clearTimeout(this.waitTimer);
      this.waitTimer = undefined;
      this.drain();
    }
  }

  private toBackground(): void {
    if (this.foreground) {
      this.foreground = false;
      const now = this.d.clock.now();
      const sc = this.state.screen;
      const s = this.state.session;
      if (sc && s && !sc.denylisted && !sc.exited && sc.sid === s.id) {
        this.emit({ type: "screen_exit", screen: exitScreen(sc, now) });
        sc.exited = true;
      }
      this.emit({ type: "track", name: "$app_backgrounded" });
      this.save();
    }
    // pagehide after visibilitychange lands here too: nothing new to emit, but try to send.
    this.drain();
  }

  private toForeground(): void {
    if (this.foreground) return;
    this.foreground = true;
    const s = this.state.session;
    if (s && this.d.clock.now() - s.lastActivity <= this.cfg.sessionTimeoutMs) {
      this.continueSession();
    } else {
      // The screen_exit was emitted at background, so endSession only closes the session.
      if (s) this.endSession(s.lastActivity);
      this.startSession("resume");
    }
    this.save();
  }

  /** A launch or foreground within the timeout: $app_foregrounded and restart the dwell timer. */
  private continueSession(): void {
    this.emit({ type: "track", name: "$app_foregrounded" });
    const sc = this.state.screen;
    if (sc) {
      sc.shownAt = this.d.clock.now();
      sc.exited = sc.denylisted;
    }
  }

  private startSession(launchType: LaunchType): void {
    const st = this.state;
    const now = this.d.clock.now();
    st.session = { id: this.d.ids.uuid4(), startedAt: now, seq: 0, lastActivity: now, screens: 0 };
    this.emit({ type: "session_start", launch_type: launchType }, now);

    const version = this.d.context.app.version;
    let current = true;
    if (st.installPending) {
      current = !!this.emit({ type: "track", name: "$app_installed" });
      if (current) st.installPending = false;
    } else if (st.appVersion !== undefined && st.appVersion !== version) {
      current = !!this.emit({ type: "track", name: "$app_updated", properties: { previous_version: st.appVersion, version } });
    }
    if (current) st.appVersion = version;

    const dropped = st.dropped;
    if (dropped > 0 && this.emit({ type: "track", name: "$events_dropped", properties: { count: dropped } })) st.dropped -= dropped;

    // warm and resume keep showing the same screen: it is the new session's entry screen.
    const sc = st.screen;
    if (launchType !== "cold" && sc) {
      sc.sid = st.session.id;
      sc.shownAt = now;
      sc.exited = sc.denylisted;
      if (!sc.denylisted) {
        const screen: Screen = { name: sc.name };
        if (sc.route !== undefined) screen.route = sc.route;
        this.emit({ type: "screen", screen });
      }
    }
  }

  /** screen_exit for a visible screen that has not had one, then session_end, both at `at`. */
  private endSession(at: number): void {
    const st = this.state;
    const s = st.session!;
    const sc = st.screen;
    if (sc && !sc.denylisted && !sc.exited && sc.sid === s.id) {
      this.emit({ type: "screen_exit", screen: exitScreen(sc, at) }, at);
      sc.exited = true;
    }
    this.emit({ type: "session_end", duration_ms: Math.max(0, at - s.startedAt), screens_viewed: s.screens, events_count: s.seq + 1 }, at);
    st.session = undefined;
  }

  private showScreen(name: string, props: Properties | undefined, route?: string): void {
    const reason = checkName(name, false) || checkProperties(props);
    if (reason) return this.refuse(reason, name);
    const st = this.state;
    const s = st.session;
    if (!s) return;
    const now = this.d.clock.now();
    const sc = st.screen;
    if (this.denylist[name]) {
      // The replaced screen gets its screen_exit; the denylisted one itself is silent.
      if (sc && !sc.denylisted && !sc.exited && sc.sid === s.id) this.emit({ type: "screen_exit", screen: exitScreen(sc, now) });
      st.screen = { name, route, shownAt: now, denylisted: true, exited: true, sid: s.id };
      this.save();
      return;
    }
    const screen: Screen = { name };
    if (route !== undefined) screen.route = route;
    if (sc && !sc.denylisted && sc.sid === s.id) {
      screen.previous = sc.name;
      screen.previous_duration_ms = sc.exited ? 0 : Math.max(0, now - sc.shownAt);
    }
    const fields: Fields = { type: "screen", screen };
    if (props) fields.properties = props;
    this.emit(fields);
    st.screen = { name, route, shownAt: now, denylisted: false, exited: !this.foreground, sid: s.id };
  }

  // ---- events and the queue (protocol 5 and 12) ---------------------------------------------

  private emit(fields: Fields, ts = this.d.clock.now()): WireEvent | undefined {
    const st = this.state;
    const s = st.session;
    if (st.consent === "denied" || !s) return undefined;
    const event = {
      event_id: this.d.ids.uuid7(ts),
      ...fields,
      device_id: st.deviceId,
      session_id: s.id,
      seq: s.seq,
      timestamp: new Date(ts).toISOString(),
      context: this.d.context,
    } as WireEvent;
    if (st.userId !== undefined && event.user_id === undefined) event.user_id = st.userId;
    const j = JSON.stringify(event);
    const n = utf8Length(j);
    if (n > MAX_EVENT_BYTES) {
      this.refuse("event_too_large", fields.name || (fields.screen && fields.screen.name) || fields.type);
      return undefined;
    }
    s.seq++;
    s.lastActivity = ts;
    if (fields.type === "screen") s.screens++;
    this.enqueue({ k: st.nextKey++, e: event, j, n });
    return event;
  }

  private enqueue(item: Item): void {
    this.queue.push(item);
    this.toAppend.push({ k: item.k, e: item.e });
    if (this.queue.length > this.cfg.maxQueue) {
      // Full: drop the oldest event that is not in flight and count it for $events_dropped.
      for (let i = 0; i < this.queue.length; i++) {
        if (!this.inflight[this.queue[i].k]) {
          this.toRemove.push(this.queue.splice(i, 1)[0].k);
          this.state.dropped++;
          break;
        }
      }
    }
    this.save();
    this.armInterval();
    if (this.queue.length >= this.cfg.flushAtCount) this.drain();
  }

  private item(q: QueuedEvent): Item {
    const j = JSON.stringify(q.e);
    return { k: q.k, e: q.e, j, n: utf8Length(j) };
  }

  private refuse(reason: Reason, name: string): void {
    this.d.logger.refused({ reason, name });
  }

  /** Schedules one write of everything changed since the last one. Resolves when it is durable. */
  private save(): Promise<void> {
    if (!this.saveScheduled) {
      this.saveScheduled = true;
      const storage = this.d.storage;
      this.writes = this.writes
        .then(async () => {
          this.saveScheduled = false;
          const clear = this.clearAll;
          const append = this.toAppend;
          const remove = this.toRemove;
          this.clearAll = false;
          this.toAppend = [];
          this.toRemove = [];
          if (clear) await storage.clearQueue();
          if (append.length) await storage.append(append);
          if (remove.length) await storage.remove(remove);
          await storage.saveState(JSON.parse(JSON.stringify(this.state)));
        })
        .catch((err) => this.storageFailed(err));
    }
    return this.writes;
  }

  private storageFailed(err: unknown): void {
    if (this.storageWarned) return;
    this.storageWarned = true;
    this.d.logger.warn(`ipase: storage failed, events may not survive a reload: ${String(err)}`);
  }

  // ---- sending (protocol 3 and 4) -----------------------------------------------------------

  private canSend(): boolean {
    return this.ready && !this.dead && !this.stopped && this.state.consent === "granted" && this.waitTimer === undefined && this.queue.length > 0;
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    if (!this.canSend()) return Promise.resolve();
    const p = this.drainLoop()
      .catch((err) => this.d.logger.warn(`ipase: ${String(err)}`))
      .then(() => {
        this.draining = undefined;
      });
    this.draining = p;
    return p;
  }

  private async drainLoop(): Promise<void> {
    while (this.canSend()) {
      // Persist first: nothing leaves the device before it is durable.
      await this.save();
      if (!this.canSend()) return;
      const items = this.nextBatch();
      if (!items.length || !(await this.send(items))) return;
    }
  }

  private nextBatch(): Item[] {
    let source = this.queue;
    while (this.splits.length) {
      const keys = this.splits.pop()!;
      const half = this.queue.filter((q) => keys.indexOf(q.k) >= 0);
      if (half.length) {
        source = half;
        break;
      }
    }
    const budget = (this.foreground ? BODY_MAX_BYTES : BACKGROUND_BODY_MAX_BYTES) - ENVELOPE_BYTES;
    const out: Item[] = [];
    let size = 0;
    for (const q of source) {
      if (this.inflight[q.k]) continue;
      if (out.length >= BATCH_MAX_EVENTS || (out.length && size + q.n + 1 > budget)) break;
      out.push(q);
      size += q.n + 1;
    }
    return out;
  }

  /** Sends one batch. Resolves true when draining may continue. */
  private async send(items: Item[]): Promise<boolean> {
    const clock = this.d.clock;
    for (const q of items) this.inflight[q.k] = true;
    const body = `{"sent_at":${JSON.stringify(new Date(clock.now()).toISOString())},"batch":[${items.map((q) => q.j).join(",")}]}`;
    const abort = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    let timer: unknown;
    const timeout = new Promise<TransportResponse>((resolve) => {
      timer = clock.setTimeout(() => {
        if (abort) abort.abort();
        resolve({ status: 0 });
      }, REQUEST_TIMEOUT_MS);
    });
    let res: TransportResponse;
    try {
      res = await Promise.race([
        this.d.transport.send({
          url: `${this.cfg.endpoint}/v1/batch`,
          headers: { Authorization: `Bearer ${this.cfg.writeKey}`, "Content-Type": "application/json", "X-SDK": `${SDK_NAME}/${SDK_VERSION}` },
          body,
          signal: abort && abort.signal,
        }),
        timeout,
      ]);
    } catch {
      res = { status: 0 };
    } finally {
      clock.clearTimeout(timer);
      for (const q of items) delete this.inflight[q.k];
    }
    if (this.dead) return false;
    return this.handle(res, items);
  }

  private handle(res: TransportResponse, items: Item[]): boolean {
    const status = res.status;
    const log = this.d.logger;
    if (status >= 200 && status < 300) {
      const rejected = res.body && (res.body as { rejected?: unknown }).rejected;
      if (Array.isArray(rejected)) {
        for (const r of rejected) {
          const q = items[r && r.index];
          log.warn(`ipase: the server rejected event ${r && r.index} (${q ? q.e.name || q.e.type : "?"}): ${r && r.reason}`);
        }
      }
      this.removeItems(items);
      this.attempts = 0;
      return true;
    }
    if (status === 400) {
      log.warn(`ipase: dropped a batch of ${items.length} events the server could not read: ${errorCode(res.body)}`);
      this.removeItems(items);
      this.attempts = 0;
      return true;
    }
    if (status === 413) {
      this.attempts = 0;
      if (items.length === 1) {
        log.warn(`ipase: dropped an event the server found too large (${items[0].e.name || items[0].e.type})`);
        this.removeItems(items);
      } else {
        // Send the first half, then the second, each under the normal rules.
        const keys = items.map((q) => q.k);
        const half = Math.ceil(keys.length / 2);
        this.splits.push(keys.slice(half), keys.slice(0, half));
      }
      return true;
    }
    if (status === 429 || status === 503) {
      this.wait(res.retryAfter !== undefined ? res.retryAfter * 1000 : this.backoff(), false);
      return false;
    }
    if (status === 0 || status >= 500) {
      this.wait(this.backoff(), status === 0);
      return false;
    }
    // 401 and every other status: keep the queue, stop until the next launch.
    this.attempts = 0;
    this.stopped = true;
    log.warn(`ipase: sending stopped until the next page load: HTTP ${status} ${errorCode(res.body)}`);
    return false;
  }

  /** min(300, 2^(n-1)) seconds for attempt n, jittered by a factor from 0.5 to 1.5. */
  private backoff(): number {
    this.attempts++;
    return Math.min(300, Math.pow(2, this.attempts - 1)) * (0.5 + this.d.ids.random()) * 1000;
  }

  private wait(ms: number, network: boolean): void {
    this.waitIsNetwork = network;
    this.waitTimer = this.d.clock.setTimeout(() => {
      this.waitTimer = undefined;
      this.drain();
    }, ms);
  }

  private removeItems(items: Item[]): void {
    const gone: { [key: number]: true } = {};
    for (const q of items) {
      gone[q.k] = true;
      this.toRemove.push(q.k);
    }
    this.queue = this.queue.filter((q) => !gone[q.k]);
    this.save();
  }

  /** The flushInterval timer runs while the queue is not empty. */
  private armInterval(): void {
    if (this.intervalTimer !== undefined || this.dead || !this.queue.length) return;
    this.intervalTimer = this.d.clock.setTimeout(() => {
      this.intervalTimer = undefined;
      this.drain();
      this.armInterval();
    }, this.cfg.flushIntervalMs);
  }
}

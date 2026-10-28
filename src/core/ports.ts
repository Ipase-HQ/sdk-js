// The only ways the core reaches the outside world. Browser adapters live in src/browser; tests
// supply their own (virtual clock, in-memory storage, scripted transport).

import type { Consent, WireEvent } from "./types";

/** Wall clock and timers. The conformance harness swaps in a virtual clock. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Visible screen as persisted (protocol 9.1). */
export interface ScreenState {
  name: string;
  route?: string;
  /** When the dwell timer last (re)started: shown, or the last foreground. */
  shownAt: number;
  denylisted: boolean;
  /** A screen_exit was already emitted for it (background or a denylisted replacement). */
  exited: boolean;
  /** Session the screen was shown in; previous is only set within one session. */
  sid: string;
}

export interface SessionState {
  id: string;
  startedAt: number;
  seq: number;
  lastActivity: number;
  screens: number;
}

/** Everything protocol 9.1 says survives process death, apart from the queue. */
export interface PersistedState {
  v: 1;
  deviceId: string;
  /** The device id was minted and $app_installed has not been queued yet. */
  installPending?: boolean;
  /** app.version at the last session_start, for $app_updated. */
  appVersion?: string;
  session?: SessionState;
  userId?: string;
  screen?: ScreenState;
  dropped: number;
  consent: Consent;
  nextKey: number;
}

/** A queued event. k is the insertion key, so storage order is queue order. */
export interface QueuedEvent {
  k: number;
  e: WireEvent;
}

export interface Loaded {
  state?: PersistedState;
  queue: QueuedEvent[];
  /** A device id found in a secondary store when the primary state is gone. */
  deviceId?: string;
}

/** Durable storage for the state and the event queue. Calls are issued one at a time, in order. */
export interface Storage {
  load(): Promise<Loaded>;
  saveState(state: PersistedState): Promise<void>;
  append(items: QueuedEvent[]): Promise<void>;
  remove(keys: number[]): Promise<void>;
  clearQueue(): Promise<void>;
  close?(): void;
}

export interface TransportRequest {
  url: string;
  headers: Record<string, string>;
  /** The uncompressed JSON body. The adapter decides on gzip. */
  body: string;
  signal?: AbortSignal;
}

/** status 0 means no response: DNS, TLS, timeout or a dropped connection. */
export interface TransportResponse {
  status: number;
  /** Retry-After in seconds, when the response carried one. */
  retryAfter?: number;
  body?: unknown;
}

export interface Transport {
  send(req: TransportRequest): Promise<TransportResponse>;
}

/** pagehide arrives as background; pageshow from the back/forward cache as foreground. */
export type LifecycleEvent = "foreground" | "background" | "online" | "offline";

export interface Lifecycle {
  isForeground(): boolean;
  subscribe(listener: (event: LifecycleEvent) => void): () => void;
}

export interface Ids {
  uuid4(): string;
  uuid7(ms: number): string;
  /** Uniform in [0, 1), for backoff jitter. */
  random(): number;
}

export interface Refusal {
  reason: string;
  name: string;
}

/** Logger plus the test log hook of protocol 15 and 17: refused() reports every local refusal. */
export interface Logger {
  warn(message: string): void;
  refused(refusal: Refusal): void;
}

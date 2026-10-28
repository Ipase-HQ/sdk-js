export type Consent = "pending" | "granted" | "denied";

export type Scalar = string | number | boolean | null;
export type Properties = Record<string, Scalar>;

export type EventType = "screen" | "screen_exit" | "track" | "identify" | "session_start" | "session_end";
export type LaunchType = "cold" | "warm" | "resume";

export interface Element {
  id?: string;
  label?: string;
  type?: string;
  screen?: string;
}

export interface Screen {
  name: string;
  route?: string;
  previous?: string;
  previous_duration_ms?: number;
  duration_ms?: number;
}

export interface Context {
  platform: "web" | "desktop";
  app: { name: string; version: string; build?: string; bundle_id: string };
  os: { name: string; version: string };
  device?: { model?: string; manufacturer?: string; screen?: string };
  browser?: { name: string; version: string };
  locale: string;
  timezone: string;
  network?: "wifi" | "cellular" | "ethernet" | "offline" | "unknown";
  sdk: { name: string; version: string; spec: string };
}

/** One event as it goes on the wire (protocol 5). */
export interface WireEvent {
  event_id: string;
  type: EventType;
  name?: string;
  device_id: string;
  user_id?: string;
  session_id: string;
  seq: number;
  timestamp: string;
  screen?: Screen;
  element?: Element;
  properties?: Properties;
  traits?: Properties;
  launch_type?: LaunchType;
  duration_ms?: number;
  screens_viewed?: number;
  events_count?: number;
  context: Context;
}

export interface Autocapture {
  screens?: boolean;
  taps?: boolean;
}

/** Core settings, already resolved from the init options. */
export interface Config {
  writeKey: string;
  endpoint: string;
  flushAtCount: number;
  flushIntervalMs: number;
  maxQueue: number;
  sessionTimeoutMs: number;
  consent: Consent;
  denylistScreens: string[];
}

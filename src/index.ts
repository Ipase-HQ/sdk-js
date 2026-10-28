// The public API, protocol section 17. One instance per page; calls before init() are ignored.

import type { Properties } from "./core/types";
import { createInstance, type Instance, type Options } from "./browser/client";

export type { Options } from "./browser/client";
export type { Consent, Properties, Scalar } from "./core/types";
export type { Clock, Refusal } from "./core/ports";
export { SDK_VERSION as version } from "./version";

let instance: Instance | undefined;

export function init(writeKey: string, options?: Options): void {
  if (instance) return console.warn("ipase: init() was already called");
  if (typeof window === "undefined") return console.warn("ipase: init() needs a browser window");
  instance = createInstance(writeKey, options);
}

export function screen(name: string, properties?: Properties): void {
  if (instance) instance.core.screen(name, properties);
}

export function track(name: string, properties?: Properties): void {
  if (instance) instance.core.track(name, properties);
}

export function identify(userId: string, traits?: Properties): void {
  if (instance) instance.core.identify(userId, traits);
}

export function reset(): void {
  if (instance) instance.core.reset();
}

export function optIn(): void {
  if (instance) instance.core.optIn();
}

export function optOut(): void {
  if (instance) instance.core.optOut();
}

export function flush(): Promise<void> {
  return instance ? instance.core.flush() : Promise.resolve();
}

/** The persisted device id, for an X-Device-Id header. Undefined until the SDK has loaded. */
export function deviceId(): string | undefined {
  return instance && instance.core.deviceId();
}

/** The current session id, for an X-Session-Id header. Undefined until the SDK has loaded. */
export function sessionId(): string | undefined {
  return instance && instance.core.sessionId();
}

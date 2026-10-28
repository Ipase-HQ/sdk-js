// Lifecycle port: visibilitychange and pagehide are background, visibilitychange to visible and a
// back/forward cache restore are foreground; online and offline pass through.

import type { Lifecycle } from "../core/ports";

export function browserLifecycle(win: Window): Lifecycle {
  const doc = win.document;
  return {
    isForeground: () => doc.visibilityState !== "hidden",
    subscribe(listener) {
      const on: Array<[EventTarget, string, () => void]> = [
        [doc, "visibilitychange", () => listener(doc.visibilityState === "hidden" ? "background" : "foreground")],
        [win, "pagehide", () => listener("background")],
        [win, "pageshow", () => doc.visibilityState !== "hidden" && listener("foreground")],
        [win, "online", () => listener("online")],
        [win, "offline", () => listener("offline")],
      ];
      for (const [target, type, fn] of on) target.addEventListener(type, fn);
      return () => {
        for (const [target, type, fn] of on) target.removeEventListener(type, fn);
      };
    },
  };
}

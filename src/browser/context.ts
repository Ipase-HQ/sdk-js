// context (protocol 8, ADR 0004), collected once per launch from the user agent and the window.

import type { Context } from "../core/types";
import { SDK_NAME, SDK_VERSION, SPEC_VERSION } from "../version";

export interface AppInfo {
  appName?: string;
  appVersion?: string;
  bundleId?: string;
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s) || "unknown";

/** Browser name and version from a user agent. Order matters: Edge and Opera also say Chrome. */
export function parseBrowser(ua: string): { name: string; version: string } {
  const rules: Array<[string, RegExp]> = [
    ["Electron", /Electron\/([\d.]+)/],
    ["Edge", /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ["Samsung Internet", /SamsungBrowser\/([\d.]+)/],
    ["Opera", /(?:OPR|Opera)\/([\d.]+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
    ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari/],
  ];
  for (const [name, re] of rules) {
    const m = re.exec(ua);
    if (m) return { name, version: clip(m[1], 32) };
  }
  return { name: "unknown", version: "unknown" };
}

/** OS name and version, plus the coarse device model the protocol allows on the web. */
export function parseOs(ua: string, touchPoints = 0): { os: { name: string; version: string }; model: string } {
  const v = (m: RegExpExecArray | null) => clip(m ? m[1].replace(/_/g, ".") : "", 32);
  let m: RegExpExecArray | null;
  if ((m = /iPad.*?OS ([\d_]+)/.exec(ua))) return { os: { name: "iPadOS", version: v(m) }, model: "iPad" };
  if ((m = /iPhone OS ([\d_]+)/.exec(ua)) || /iPhone/.test(ua)) return { os: { name: "iOS", version: v(m) }, model: "iPhone" };
  if ((m = /Android ([\d.]+)/.exec(ua)) || /Android/.test(ua)) return { os: { name: "Android", version: v(m) }, model: "Android" };
  if ((m = /Mac OS X ([\d_.]+)/.exec(ua)) || /Macintosh/.test(ua)) {
    // iPadOS 13+ presents itself as a Mac; touch support gives it away.
    if (touchPoints > 1) return { os: { name: "iPadOS", version: v(m) }, model: "iPad" };
    return { os: { name: "macOS", version: v(m) }, model: "Mac" };
  }
  if ((m = /Windows NT ([\d.]+)/.exec(ua)) || /Windows/.test(ua)) return { os: { name: "Windows", version: v(m) }, model: "Windows PC" };
  if ((m = /CrOS \S+ ([\d.]+)/.exec(ua)) || /CrOS/.test(ua)) return { os: { name: "ChromeOS", version: v(m) }, model: "unknown" };
  if (/Linux/.test(ua)) return { os: { name: "Linux", version: "unknown" }, model: "unknown" };
  return { os: { name: "unknown", version: "unknown" }, model: "unknown" };
}

export function collectContext(win: Window, app: AppInfo): Context {
  const nav = win.navigator;
  const ua = nav.userAgent || "";
  const browser = parseBrowser(ua);
  const { os, model } = parseOs(ua, nav.maxTouchPoints || 0);
  let timezone = "";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    // older engines
  }
  const ctx: Context = {
    platform: browser.name === "Electron" ? "desktop" : "web",
    app: {
      name: clip(app.appName || win.location.hostname || "", 128),
      version: clip(app.appVersion || "", 32),
      bundle_id: clip(app.bundleId || win.location.origin || "", 256),
    },
    os,
    device: { model },
    browser,
    locale: clip(nav.language || "", 16),
    timezone: clip(timezone || "UTC", 64),
    sdk: { name: SDK_NAME, version: SDK_VERSION, spec: SPEC_VERSION },
  };
  const w = win.innerWidth;
  const h = win.innerHeight;
  if (w > 0 && h > 0) ctx.device!.screen = `${Math.round(w)}x${Math.round(h)}`;
  return ctx;
}

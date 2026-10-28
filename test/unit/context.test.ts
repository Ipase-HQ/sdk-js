// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { collectContext, parseBrowser, parseOs } from "../../src/browser/context";

const UA = {
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.92 Safari/537.36",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68",
  safariIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  samsung: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  electron: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) MyApp/2.1.0 Chrome/130.0.6723.59 Electron/33.0.2 Safari/537.36",
};

describe("user agent parsing", () => {
  it("browsers", () => {
    expect(parseBrowser(UA.chromeMac)).toEqual({ name: "Chrome", version: "130.0.6723.92" });
    expect(parseBrowser(UA.edgeWin)).toEqual({ name: "Edge", version: "130.0.2849.68" });
    expect(parseBrowser(UA.safariIos)).toEqual({ name: "Safari", version: "18.1" });
    expect(parseBrowser(UA.firefoxLinux)).toEqual({ name: "Firefox", version: "132.0" });
    expect(parseBrowser(UA.samsung)).toEqual({ name: "Samsung Internet", version: "26.0" });
    expect(parseBrowser(UA.electron)).toEqual({ name: "Electron", version: "33.0.2" });
    expect(parseBrowser("curl/8")).toEqual({ name: "unknown", version: "unknown" });
  });

  it("operating systems and device models", () => {
    expect(parseOs(UA.chromeMac)).toEqual({ os: { name: "macOS", version: "10.15.7" }, model: "Mac" });
    expect(parseOs(UA.chromeMac, 5)).toEqual({ os: { name: "iPadOS", version: "10.15.7" }, model: "iPad" });
    expect(parseOs(UA.edgeWin)).toEqual({ os: { name: "Windows", version: "10.0" }, model: "Windows PC" });
    expect(parseOs(UA.safariIos)).toEqual({ os: { name: "iOS", version: "18.1" }, model: "iPhone" });
    expect(parseOs(UA.samsung)).toEqual({ os: { name: "Android", version: "14" }, model: "Android" });
    expect(parseOs(UA.firefoxLinux)).toEqual({ os: { name: "Linux", version: "unknown" }, model: "unknown" });
  });
});

describe("collectContext", () => {
  it("web: platform web, bundle_id from the origin, sdk.spec", () => {
    Object.defineProperty(window.navigator, "userAgent", { value: UA.chromeMac, configurable: true });
    const ctx = collectContext(window, { appName: "Shop", appVersion: "3.2.1" });
    expect(ctx.platform).toBe("web");
    expect(ctx.app).toEqual({ name: "Shop", version: "3.2.1", bundle_id: window.location.origin });
    expect(ctx.browser).toEqual({ name: "Chrome", version: "130.0.6723.92" });
    expect(ctx.sdk).toEqual({ name: "js", version: "0.1.0", spec: "1.0.0-draft.3" });
    expect(ctx.device!.screen).toMatch(/^\d+x\d+$/);
  });

  it("Electron: platform desktop, bundle_id from the option", () => {
    Object.defineProperty(window.navigator, "userAgent", { value: UA.electron, configurable: true });
    const ctx = collectContext(window, { appName: "MyApp", appVersion: "2.1.0", bundleId: "com.mango.desktop" });
    expect(ctx.platform).toBe("desktop");
    expect(ctx.browser).toEqual({ name: "Electron", version: "33.0.2" });
    expect(ctx.app.bundle_id).toBe("com.mango.desktop");
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { autocapture, describeControl } from "../../src/browser/autocapture";
import type { Core } from "../../src/core/client";

afterEach(() => {
  document.body.innerHTML = "";
});

function fakeCore() {
  return { screenAuto: vi.fn(), tap: vi.fn() } as unknown as Core & { screenAuto: ReturnType<typeof vi.fn>; tap: ReturnType<typeof vi.fn> };
}

describe("describeControl", () => {
  it("prefers data-monitor-id, then id; aria-label, then trimmed text", () => {
    document.body.innerHTML = `
      <button id="b1" data-monitor-id="buy">  Buy
        now </button>
      <a id="l1" aria-label="Home link">Home</a>
      <div role="button"><span id="inner">Open</span></div>
      <p id="p">not a control</p>`;
    expect(describeControl(document.getElementById("b1"))).toEqual({ id: "buy", label: "Buy now", type: "button" });
    expect(describeControl(document.getElementById("l1"))).toEqual({ id: "l1", label: "Home link", type: "a" });
    expect(describeControl(document.getElementById("inner"))).toEqual({ id: undefined, label: "Open", type: "div" });
    expect(describeControl(document.getElementById("p"))).toBeUndefined();
  });

  it("never reads a text field's value, a submit input's value, or contenteditable text", () => {
    document.body.innerHTML = `
      <input id="pw" type="password" value="hunter2">
      <input id="go" type="submit" value="secret-submit">
      <textarea id="ta" role="button">typed-secret</textarea>
      <div contenteditable="true"><button id="eb">edited-secret</button></div>`;
    (document.getElementById("pw") as HTMLInputElement).value = "hunter2";
    expect(describeControl(document.getElementById("pw"))).toBeUndefined();
    expect(describeControl(document.getElementById("go"))).toEqual({ id: "go", label: undefined, type: "input" });
    expect(describeControl(document.getElementById("ta"))).toEqual({ id: "ta", label: undefined, type: "textarea" });
    expect(JSON.stringify(describeControl(document.getElementById("eb")))).not.toContain("secret");
  });
});

describe("autocapture", () => {
  it("emits the initial load and every History API change; restores history on stop", () => {
    const core = fakeCore();
    const push = history.pushState;
    const stop = autocapture(window, core, { screens: true, taps: false });
    history.pushState({}, "", "/orders/7");
    history.replaceState({}, "", "/orders/8?q=secret#frag");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(core.screenAuto.mock.calls.map((c) => c[0])).toEqual([expect.any(String), "/orders/7", "/orders/8", "/orders/8"]);
    stop();
    expect(history.pushState).toBe(push);
  });

  it("delegates clicks to tap and stops listening on stop", () => {
    const core = fakeCore();
    document.body.innerHTML = `<button data-monitor-id="go">Go</button><input id="name" type="text">`;
    const stop = autocapture(window, core, { screens: false, taps: true });
    (document.querySelector("button") as HTMLButtonElement).click();
    (document.getElementById("name") as HTMLInputElement).click();
    expect(core.tap.mock.calls).toEqual([[{ id: "go", label: "Go", type: "button" }]]);
    stop();
    (document.querySelector("button") as HTMLButtonElement).click();
    expect(core.tap).toHaveBeenCalledTimes(1);
  });
});

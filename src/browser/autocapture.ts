// Auto-capture (protocol 14): the initial load and every History API change as screens, and a
// delegated click listener for taps. Text field contents are never read: inputs, textareas,
// selects and contenteditable regions contribute only their aria-label, never a value or text.

import type { Core } from "../core/client";
import type { Autocapture } from "../core/types";

const CONTROLS = "button,a,input[type=button],input[type=submit],[role=button]";
const NO_TEXT = { input: 1, textarea: 1, select: 1 } as { [tag: string]: 1 };

/** id, label and type of a clicked control, or undefined when the click was not on one. */
export function describeControl(target: EventTarget | null): { id?: string; label?: string; type: string } | undefined {
  const start = target as Element | null;
  const el = start && typeof start.closest === "function" ? (start.closest(CONTROLS) as HTMLElement | null) : null;
  if (!el) return undefined;
  const type = el.tagName.toLowerCase();
  const id = el.getAttribute("data-monitor-id") || el.id || undefined;
  let label = el.getAttribute("aria-label") || "";
  if (!label && !NO_TEXT[type] && !el.isContentEditable) label = el.textContent || "";
  label = label.replace(/\s+/g, " ").trim();
  return { id, label: label || undefined, type };
}

export function autocapture(win: Window, core: Core, opts: Required<Autocapture>): () => void {
  const undo: Array<() => void> = [];
  if (opts.screens) {
    const history = win.history;
    const emit = () => core.screenAuto(win.location.pathname);
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method];
      const wrapped = function (this: History, ...args: Parameters<History["pushState"]>) {
        const result = original.apply(this, args);
        emit();
        return result;
      };
      history[method] = wrapped;
      undo.push(() => {
        if (history[method] === wrapped) history[method] = original;
      });
    }
    win.addEventListener("popstate", emit);
    undo.push(() => win.removeEventListener("popstate", emit));
    emit();
  }
  if (opts.taps) {
    const onClick = (e: Event) => {
      const control = describeControl(e.target);
      if (control) core.tap(control);
    };
    win.document.addEventListener("click", onClick, true);
    undo.push(() => win.document.removeEventListener("click", onClick, true));
  }
  return () => undo.forEach((fn) => fn());
}

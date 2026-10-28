// Transport port over fetch. keepalive on every request whose body fits the 64 KB browsers allow
// for keepalive, which is every background flush (ADR 0005); never sendBeacon, which cannot carry
// the Authorization header. Redirects are not followed (protocol 2.1).

import type { Transport, TransportResponse } from "../core/ports";
import { gzip } from "./gzip";

const GZIP_OVER_BYTES = 1024;
const KEEPALIVE_MAX_BYTES = 64 * 1024;

function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (isFinite(seconds) && value.trim() !== "") return Math.max(0, seconds);
  const date = Date.parse(value);
  return isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
}

export function fetchTransport(): Transport {
  return {
    async send(req): Promise<TransportResponse> {
      const headers = { ...req.headers };
      let body: string | Uint8Array = req.body;
      const raw = new TextEncoder().encode(req.body);
      let size = raw.length;
      if (size > GZIP_OVER_BYTES) {
        body = await gzip(req.body);
        size = body.length;
        headers["Content-Encoding"] = "gzip";
      }
      let res: Response;
      try {
        // Read fetch at call time so a host (or a test harness) can wrap it.
        res = await globalThis.fetch(req.url, {
          method: "POST",
          headers,
          body: body as BodyInit,
          keepalive: size <= KEEPALIVE_MAX_BYTES,
          credentials: "omit",
          redirect: "manual",
          signal: req.signal,
        });
      } catch {
        return { status: 0 };
      }
      // An unfollowed redirect is a misconfiguration, not a network failure.
      const status = res.type === "opaqueredirect" ? 302 : res.status;
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = undefined;
      }
      return { status, retryAfter: retryAfter(res.headers.get("Retry-After")), body: parsed };
    },
  };
}

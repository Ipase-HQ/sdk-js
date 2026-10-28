// @vitest-environment happy-dom
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTransport } from "../../src/browser/transport";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function capture(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  }) as never;
  return calls;
}

const req = (body: string) => ({ url: "http://x.test/v1/batch", headers: { Authorization: "Bearer k" }, body });

describe("fetchTransport", () => {
  it("small bodies go uncompressed with keepalive and no credentials", async () => {
    const calls = capture(() => new Response('{"accepted":1,"rejected":[]}', { status: 202 }));
    const res = await fetchTransport().send(req('{"a":1}'));
    expect(res).toEqual({ status: 202, retryAfter: undefined, body: { accepted: 1, rejected: [] } });
    expect(calls[0].init).toMatchObject({ method: "POST", keepalive: true, credentials: "omit", redirect: "manual", body: '{"a":1}' });
    expect(calls[0].init.headers).toEqual({ Authorization: "Bearer k" });
  });

  it("bodies over 1 KB are gzipped; keepalive only while the wire body fits 64 KB", async () => {
    const calls = capture(() => new Response(null, { status: 202 }));
    const text = JSON.stringify({ v: "x".repeat(5000) });
    await fetchTransport().send(req(text));
    expect((calls[0].init.headers as Record<string, string>)["Content-Encoding"]).toBe("gzip");
    expect(gunzipSync(calls[0].init.body as Uint8Array).toString()).toBe(text);
    expect(calls[0].init.keepalive).toBe(true);

    const random = Array.from({ length: 30_000 }, () => Math.random().toString(36).slice(2, 8)).join("");
    await fetchTransport().send(req(JSON.stringify({ v: random })));
    expect(calls[1].init.keepalive).toBe(false);
  });

  it("reports Retry-After in seconds and network errors as status 0", async () => {
    capture(() => new Response("{}", { status: 429, headers: { "Retry-After": "30" } }));
    expect((await fetchTransport().send(req("{}"))).retryAfter).toBe(30);
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as never;
    expect(await fetchTransport().send(req("{}"))).toEqual({ status: 0 });
  });
});

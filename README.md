# @ipase/browser

The Ipase SDK for web and Electron apps. It records screens, taps, sessions and custom events, persists them in IndexedDB, and sends them in batches to the Ipase ingest service. Zero runtime dependencies, ES2019, about 8 KB gzipped.

It implements sdk-spec 1.0.0-draft.4 (`../sdk-spec/protocol.md`). The version is declared in package.json under `ipase.spec` and reported in `context.sdk.spec`.

## Use

```ts
import * as Ipase from "@ipase/browser";

Ipase.init("wk_live_...", { endpoint: "https://in.example.com", appName: "Shop", appVersion: "3.2.1" });
Ipase.track("checkout_started", { cart_items: 3 });
Ipase.identify("u_123", { plan: "pro" });
Ipase.reset(); // on logout

// Forward the ids on your own API calls (ADR 0003).
fetch("/api/orders", { headers: { "X-Device-Id": Ipase.deviceId() ?? "", "X-Session-Id": Ipase.sessionId() ?? "" } });
```

Or with a script tag, the UMD build exposes the global `Ipase`.

The default endpoint is `https://in.ipase.invalid`, a placeholder that never resolves, until the product domain is registered (`DEFAULT_ENDPOINT` in src/version.ts). Pass `endpoint` until then.

## API (protocol section 17)

`init(writeKey, options)`, `screen(name, properties)`, `track(name, properties)`, `identify(userId, traits)`, `reset()`, `optIn()`, `optOut()`, `flush()`, `deviceId()`, `sessionId()`.

| Option | Default | Meaning |
| --- | --- | --- |
| endpoint | placeholder | Ingest origin; `/v1/batch` is appended |
| appName | location.hostname | context.app.name |
| appVersion | unknown | context.app.version. Under Electron pass `app.getVersion()` |
| bundleId | location.origin | context.app.bundle_id. Set it under Electron |
| flushInterval | 15 | Seconds between flushes while the queue is not empty |
| flushAt | 30 | Queued events that trigger a flush |
| maxQueue | 10000 | Queue capacity; the oldest event is dropped and counted |
| sessionTimeout | 1800 | Seconds in the background before a session ends |
| autocapture | `{ screens: true, taps: true }` | `false` turns both off |
| consent | granted | Used when no consent is persisted: pending, granted or denied |
| denylistScreens | [] | Screen names that stay silent |
| clock, logHook | | Test hooks: a Clock port and a callback for every local refusal |

`deviceId()` and `sessionId()` return undefined until the SDK has loaded its state from storage, which takes one IndexedDB round trip after `init()`.

## How it works

- `src/core` is platform-agnostic: sessions, identity, consent, local validation, auto-capture event shaping, the persisted queue, batching and the retry rules. It reaches the outside only through the ports in `src/core/ports.ts`: Clock, Storage, Transport, Lifecycle, Ids and Logger.
- `src/browser` implements the ports: IndexedDB with a localStorage fallback (the device id is mirrored in localStorage), fetch with keepalive and gzip (CompressionStream, else a stored-block gzip), visibilitychange, pagehide, pageshow, online and offline, History API screens and a delegated click listener.
- Every event is written to storage before the request that carries it. One request is in flight at a time. A batch leaves the queue only on a 2xx, or when the protocol says to drop it (400, a single-event 413).
- Background flushes keep each body under 64 KB. Every request whose wire body fits 64 KB uses keepalive; a foreground batch larger than that (up to 1 MB) is sent without keepalive, because browsers refuse keepalive bodies over 64 KB.
- An `online` event ends a backoff wait caused by a network failure, so a reconnect sends at once. A Retry-After wait from a 429 or 503 is always honoured in full.
- Taps never read the value of an input, textarea or select, or the text of a contenteditable region. Only aria-label, data-monitor-id, id and the visible text of buttons and links are used.

## Commands

- `npm install`
- `npm test`: Vitest unit tests (core on a virtual clock, browser adapters in happy-dom)
- `npm run conformance`: every fixture in ../sdk-spec/fixtures that lists js, against the mock server. Locally it starts `../sdk-spec/mock-server/dist/cli.js` (run `npm run build` there if its src changed). Set `MOCK_SERVER_URL` and `FIXTURES_DIR` to use a running server instead, as CI does with `ghcr.io/ipase-hq/sdk-spec/mock-server:<spec>`
- `npm run lint`, `npm run typecheck`, `npm run build`, `npm run size` (15 KB gzipped limit)
- `npm run check`: all of the above

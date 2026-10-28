# sdk-js

TypeScript SDK for web and Electron apps of the User Monitoring Platform. Built in playbook Session 1.4. The contract is ../sdk-spec (schema/batch.schema.json and protocol.md); the workspace CLAUDE.md one level up holds the settled decisions.

## Non-negotiables

- Zero runtime dependencies; under 15 KB gzipped; ES2019 output with an ESM and a UMD build.
- Every event is persisted (IndexedDB, localStorage fallback) before any network call; a batch leaves the queue only on a 202.
- Flush at 30 events, every 15 s, on visibilitychange to hidden, and on pagehide, with fetch keepalive on every request whose wire body fits 64 KB (never sendBeacon, see ../docs/adr/0005-web-transport-fetch-keepalive.md); background flushes keep each body under 64 KB. Browsers refuse keepalive above 64 KB, so only a larger foreground batch goes without it.
- Retry rules exactly as protocol.md states; never retry after a 2xx.
- Auto-capture: History API pushState, replaceState and popstate plus the initial load as screen events; delegated click listener on button, a, input[type=submit] and [role=button] emitting the reserved $tap event with element.id or element.label (ADR 0001); never read values from inputs, textareas or contenteditable elements.
- context.platform is web in a browser and desktop under Electron; context.browser carries name and version; context.sdk.spec carries the sdk-spec VERSION (ADR 0004).
- Expose deviceId() and sessionId() so a host app can forward X-Device-Id and X-Session-Id on its own API calls (ADR 0003).
- Consent states pending, granted, denied; optOut() takes effect within one flush.
- Public API: init, screen, track, identify, reset, optIn, optOut, flush, matching ../sdk-spec/protocol.md.

## Commands

- Use Node 22 (nvm use; .nvmrc).
- npm install; npm test (Vitest unit tests); npm run lint; npm run typecheck; npm run build; npm run size (size-limit, 15 KB)
- npm run conformance: every ../sdk-spec/fixtures file listing js, driven against the browser adapters in happy-dom with fake-indexeddb and a virtual clock. Locally it starts ../sdk-spec/mock-server/dist/cli.js; CI runs ghcr.io/ipase-hq/sdk-spec/mock-server at package.json ipase.spec and reads the fixtures out of that image (MOCK_SERVER_URL, FIXTURES_DIR).
- npm run check runs everything.

## Layout

- src/core: platform-agnostic core. ports.ts holds the Clock, Storage, Transport, Lifecycle, Ids and Logger interfaces; client.ts the session, queue and retry engine.
- src/browser: the browser adapters and createInstance(); src/index.ts is the public API singleton.
- src/version.ts: SDK_VERSION and SPEC_VERSION (kept equal to package.json by a test) and DEFAULT_ENDPOINT.
- When the spec version changes: update package.json ipase.spec and SPEC_VERSION together, then run conformance.

## Conformance harness notes

- Screen auto-capture is off in the harness: fixture screen names are not pathnames, and an initial-load screen would be an entry screen no fixture expects. Screens are driven through screen(name); taps go through real DOM clicks.
- happy-dom's same-origin policy is disabled there because the mock server answers no CORS preflight.

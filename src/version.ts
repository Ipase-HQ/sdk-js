// Identity of this build. test/unit/version.test.ts keeps these equal to package.json.

/** The SDK name in X-SDK and context.sdk.name. */
export const SDK_NAME = "js";
/** This package's semver, in X-SDK and context.sdk.version. */
export const SDK_VERSION = "0.1.0";
/** The sdk-spec VERSION this build implements, in context.sdk.spec. */
export const SPEC_VERSION = "1.0.0-draft.4";

/**
 * Default ingest host until the product domain is registered. The .invalid TLD never resolves, so
 * an app that forgets the endpoint option sends nothing anywhere instead of to a guessed domain.
 * Replace this one constant when the in. hostname is settled.
 */
export const DEFAULT_ENDPOINT = "https://in.ipase.invalid";

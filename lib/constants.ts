// Placeholder mainThreadId assigned to a freshly-created "new thread" that
// hasn't been persisted yet. Filter it out before writing to anything
// (URL, telemetry, etc.) — the placeholder has no backing record on the
// server, so anything that points back at it would 404 on the next page
// load. (Used to gate localStorage; the localStorage write itself was
// removed in issue #27 once URL became the source of truth.)
export const LOCAL_THREAD_PREFIX = "__LOCALID_";

// User-facing product name. Don't hardcode "LangGraph" / "assistant-ui"
// strings elsewhere; import this so the brand is one-line to change.
export const APP_NAME = "LangGraph App";

// Title shown for a newly created thread that has no user-given name yet.
// Used by the Drizzle column default, the threads module, and the UI as a
// fallback when the runtime hasn't loaded a real title.
export const DEFAULT_THREAD_TITLE = "New Chat";

// localStorage key for the set of NFT gallery group keys the user has
// collapsed. The card persists per-group collapse state across refreshes
// so a user who closes the "Bridge to Base" airdrop bucket doesn't have to
// re-collapse it every visit. Value is a JSON array of group keys (each
// key is "${network}:${contractAddress}").
export const NFT_GALLERY_COLLAPSED_STORAGE_KEY = "nft-gallery:collapsed-groups";

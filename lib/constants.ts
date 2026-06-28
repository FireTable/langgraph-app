// Placeholder mainThreadId assigned to a freshly-created "new thread" that
// hasn't been persisted yet. Filter it out before writing to localStorage —
// we don't want to "remember" a thread id that has no backing record on
// the server, otherwise the next page load would try to switchToThread a
// ghost and hit 404.
export const LOCAL_THREAD_PREFIX = "__LOCALID_";

// localStorage key for the active thread id. Must match the string the
// runtime reads on hydration.
export const ACTIVE_THREAD_ID = "ACTIVE_THREAD_ID";

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

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

// ponytail: kbAgent stamps this onto the file part's filename to mark
// it as KB-ingested. Sits between brackets so a bare docId never
// collides with user filenames (which can contain hyphens, dots,
// etc.) and so a plain text search for "[kb:" surfaces every KB
// document. Front-end strips the prefix before displaying the
// filename; back-end extracts the docId via KB_REF_PREFIX_REGEX.
//
// Why filename (and not a `kb_ref` sibling field on the file part):
// `@assistant-ui/react-langgraph`'s `contentToParts` rebuilds file
// parts from scratch with only {type, filename, data, mimeType} —
// every sibling field is dropped. A standalone `{ type: "kb_ref" }`
// part is filtered to null by the same SDK switch. Bracketing the
// docId into the filename is the one signal that survives the
// round-trip on both directions (composer → backend → chat UI).
export const KB_REF_PREFIX = "[kb:";
export const KB_REF_SUFFIX = "]";
// ponytail: matches the leading `[kb:<docId>]` (optional trailing space).
// docId is `d-<uuid>` so `[^\]]+` is safe — `]` never appears in a uuid.
export const KB_REF_PREFIX_REGEX = /^\[kb:([^\]]+)\]\s?/;

import { tool } from "@langchain/core/tools";
import { immutableJSONPatch } from "immutable-json-patch";

import { MEMORY_PROFILE_MAX_BYTES } from "@/lib/memory/constants";
import { getAuthInfo, getMemoryDoc, putMemoryDoc } from "@/lib/memory/queries";
import { mergeMemory, type AuthInfo, type MemoryDoc } from "@/lib/memory/merge";
import { SaveMemoryInputSchema, type SaveMemoryInput } from "@/lib/memory/validators";
import { assertProfileSize, MemorySizeError } from "@/backend/memory/profile-size";
import { invalidateMemory } from "@/backend/memory/recall";

// ponytail: FR-023 fail-fast — a missing/empty userId on a *write* is
// never safe (we'd silently write to the wrong user's profile or, worse,
// a global namespace). Surface it as a structured error so the model
// (and our tests) can distinguish it from upstream store failures.
export class MissingUserIdError extends Error {
  readonly code = "MISSING_USER_ID" as const;
  constructor() {
    super("save_memory requires a non-empty config.configurable.userId");
    this.name = "MissingUserIdError";
  }
}

export class MemoryPatchError extends Error {
  readonly code = "PATCH_FAILED" as const;
  constructor(message: string) {
    super(message);
    this.name = "MemoryPatchError";
  }
}

function extractUserId(config?: { configurable?: { userId?: unknown } }): string | null {
  const raw = config?.configurable?.userId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

const EMPTY_AUTH: AuthInfo = { name: null, email: null, avatar: null, socials: [] };

async function impl(
  input: SaveMemoryInput,
  config?: { configurable?: { userId?: unknown } },
): Promise<string> {
  const userId = extractUserId(config);
  if (!userId) throw new MissingUserIdError();

  const { patches } = input;

  const [storeDoc, auth] = await Promise.all([
    getMemoryDoc(userId),
    getAuthInfo(userId).catch(() => EMPTY_AUTH),
  ]);
  // ponytail: patches operate on the merged view (store + auth
  // overlay) — same shape the model sees in <memory>. Validating
  // against `effective` lets `replace /name "X"` succeed when the
  // model is reacting to a name field that came from OAuth, without
  // a brittle replace→add fallback that hides the truth from the
  // model.
  const effective = mergeMemory(storeDoc, auth);
  for (const patch of patches) {
    if ((patch.op === "replace" || patch.op === "remove") && !(patch.path.slice(1) in effective)) {
      throw new MemoryPatchError(`path ${patch.path} not found in memory`);
    }
  }
  const next = immutableJSONPatch(effective, patches) as MemoryDoc;
  // ponytail: write-back only persists fields that diverge from auth.
  // Without this, every save_memory would copy the OAuth email/name
  // into store — bloating the doc and making "is this from account?"
  // impossible to answer from the store alone. Auth-only fields that
  // weren't touched (or were `remove`d) drop out; patched fields
  // become store-owned and win the next merge.
  const nextStore = filterToStoreOnly(next, storeDoc, patches);
  assertProfileSize(nextStore, MEMORY_PROFILE_MAX_BYTES);
  await putMemoryDoc(userId, nextStore);
  // ponytail: bust the per-turn recall cache so the very next model
  // invoke sees the patched profile. Without this, a user who edits
  // their About-you mid-conversation would keep seeing the old copy
  // until the 60s TTL (or LRU eviction) catches up.
  invalidateMemory(userId);
  // ponytail: the tool's ToolMessage is what the SaveMemoryCard reads
  // to render a before/after diff. We re-walk the patch list against
  // a running copy of the doc so each entry's `oldValue` is the value
  // that was actually there *just before that patch ran* — a
  // `remove /city` after a `replace /city` should report the replaced
  // value, not the original. Without the running copy the card would
  // show stale (and misleading) "before" values when a single call
  // chains multiple ops on the same key.
  const running: MemoryDoc = { ...effective };
  const normalized: Array<
    | { op: "add"; path: string; value: unknown }
    | { op: "replace"; path: string; oldValue: unknown; value: unknown }
    | { op: "remove"; path: string; oldValue: unknown }
  > = [];
  for (const p of patches) {
    const path = p.path.slice(1);
    if (p.op === "add") {
      normalized.push({ op: "add", path, value: p.value });
      running[path] = p.value;
    } else if (p.op === "replace") {
      normalized.push({ op: "replace", path, oldValue: running[path], value: p.value });
      running[path] = p.value;
    } else {
      normalized.push({ op: "remove", path, oldValue: running[path] });
      delete running[path];
    }
  }
  return JSON.stringify({
    ok: true,
    bytes: JSON.stringify(nextStore).length,
    keyCount: Object.keys(nextStore).length,
    before: effective,
    after: next,
    patches: normalized,
  });
}

// ponytail: a field stays in store when it was already in store (we
// own it) OR a patch wrote a new value into the merged view. Fields
// that exist only because of the auth overlay and weren't touched
// drop out — without this, every save_memory would copy the OAuth
// email/name into store, bloating the doc and making "is this from
// account?" impossible to answer from the store alone.
//
// Note: `next` is the result of immutableJSONPatch(effective, ...).
// The patch library preserves keys that weren't in `effective`, so a
// patch like `replace /city "Munich"` leaves `name` in `next` (with
// its old value) even if no patch touched it. We use the patch set
// itself as the source of truth for what changed.
function filterToStoreOnly(
  next: MemoryDoc,
  storeDoc: MemoryDoc,
  patches: SaveMemoryInput["patches"],
): MemoryDoc {
  const out: MemoryDoc = {};
  const storeKeys = new Set(Object.keys(storeDoc));
  const patchedKeys = new Set(patches.map((p) => p.path.slice(1)));
  for (const [k, v] of Object.entries(next)) {
    if (storeKeys.has(k) || patchedKeys.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

// ponytail: pass SaveMemoryInputSchema directly to LangChain's `tool(...)` —
// wrapping with `z.preprocess + z.any()` collapses the JSON-Schema view to
// `{ type: "any" }` and the LLM is left guessing the {patches:[...]} shape
// (verified live: agent "I keep hitting a schema mismatch" loops through
// array vs plain-object vs envelope variants). The envelope doubles as the
// API contract — test fixtures and the SDK agree on the same wire format.
export const saveMemoryTool = tool(impl, {
  name: "save_memory",
  description: `Persist a structured fact to the user's long-term profile via RFC 6902 JSON Patch operations. Without these facts the agent cannot remember the user across conversations.

WHEN TO CALL:
- The user explicitly states a stable biographical fact (role, location, preference, project context, recurring schedule).
- The conversation reveals a durable fact useful for future sessions (primary tech stack, stable tool/service relationships, facts surfaced via tool calls like ask_location or place_crypto_order).

CONSTRAINTS (DO NOT):
- DO NOT save ephemeral chat ("I'm tired", "today is hot", single emojis).
- DO NOT save model inferences or questions about the user.
- DO NOT save sensitive content the user wouldn't want surfaced later (passwords, financial details, medical info, intimate relationships) — use judgment.
- DO NOT save external data returned by tools (weather, prices, balances, fetched URLs) — only the user's input portion.
- DO NOT call more than once per turn (group multiple updates into one patch set).
- DO NOT save the same or similar content under two keys (e.g. use "ask_location_cache" instead of both "ask_location_cache" and "ask_location_result").

CONFLICT RESOLUTION:
If the same key already exists with a different value, ask a brief clarifying question before overwriting. Facts evolve — don't silently rewrite the user's history.

FALLBACK:
If save_memory is not in your current tool list, treat the statement as ephemeral and continue.

SCHEMA:
Pass input as { "patches": [...] }. Each patch MUST have:
- "op": "add" | "replace" | "remove".
- "path": "/<key>" (RFC 6901 pointer; key must start with a letter or underscore).
- "value": required for add/replace; any JSON-compatible value.

EXAMPLES:
1. User says "I'm Lin, a backend engineer in Singapore" (no prior memory):
   save_memory({ "patches": [
     { "op": "add", "path": "/name", "value": "Lin" },
     { "op": "add", "path": "/role", "value": "backend engineer" },
     { "op": "add", "path": "/city", "value": "Singapore" }
   ] })

2. Existing memory has { "city": "Berlin" }. User says "actually I moved to Munich last month":
   save_memory({ "patches": [
     { "op": "replace", "path": "/city", "value": "Munich" }
   ] })

3. User says "forget my wallet address" and memory has { "wallet": "0xabc" }:
   save_memory({ "patches": [
     { "op": "remove", "path": "/wallet" }
   ] })`,
  schema: SaveMemoryInputSchema,
});

export { MemorySizeError };

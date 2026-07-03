import { tool } from "@langchain/core/tools";
import { immutableJSONPatch } from "immutable-json-patch";

import { MEMORY_PROFILE_MAX_BYTES } from "@/lib/memory/constants";
import { getProfileDoc, putProfileDoc } from "@/lib/memory/queries";
import { SaveMemoryInputSchema, type SaveMemoryInput } from "@/lib/memory/validators";
import { assertProfileSize, MemorySizeError } from "@/backend/memory/profile-size";

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

async function impl(
  input: SaveMemoryInput,
  config?: { configurable?: { userId?: unknown } },
): Promise<string> {
  const userId = extractUserId(config);
  if (!userId) throw new MissingUserIdError();

  const { patches } = input;

  const current = await getProfileDoc(userId);
  // ponytail: validate replace/remove paths up-front — silently no-op'ing
  // a missing path would let the model "remember" a fact it never
  // persisted. immutableJSONPatch returns a fresh object, so no clone
  // is needed.
  for (const patch of patches) {
    if ((patch.op === "replace" || patch.op === "remove") && !(patch.path.slice(1) in current)) {
      throw new MemoryPatchError(`path ${patch.path} not found in profile`);
    }
  }
  const next = immutableJSONPatch(current, patches) as Record<string, unknown>;
  assertProfileSize(next, MEMORY_PROFILE_MAX_BYTES);
  await putProfileDoc(userId, next);
  return JSON.stringify({
    ok: true,
    bytes: JSON.stringify(next).length,
    keyCount: Object.keys(next).length,
  });
}

// ponytail: pass SaveMemoryInputSchema directly to LangChain's `tool(...)` —
// wrapping with `z.preprocess + z.any()` collapses the JSON-Schema view to
// `{ type: "any" }` and the LLM is left guessing the {patches:[...]} shape
// (verified live: agent "I keep hitting a schema mismatch" loops through
// array vs plain-object vs envelope variants). The envelope doubles as the
// API contract — test fixtures and the SDK agree on the same wire format.
export const saveMemoryTool = tool(impl, {
  name: "save_memory",
  description: `Persist a structured fact to the user's long-term profile via RFC 6902 JSON Patch operations. Use it whenever the user reveals a stable fact about themselves (name, role, location, preferences, wallet, language, project, etc.) so future conversations can recall them without re-asking. Without these facts the agent cannot remember the user across conversations.

Pass the input as { "patches": [...] }. Each patch object MUST have:
  - "op": one of "add" (set/insert a field), "replace" (overwrite an existing field), "remove" (delete a field).
  - "path": the field as "/<key>" (RFC 6901 pointer starting with /; key must start with a letter or underscore).
  - "value": required for add/replace; any JSON-compatible value (string, number, boolean, array, object).

Example — the user says "I'm Lin, a backend engineer in Singapore" → call:
  save_memory({ "patches": [
    { "op": "add", "path": "/name", "value": "Lin" },
    { "op": "add", "path": "/role", "value": "backend engineer" },
    { "op": "add", "path": "/city", "value": "Singapore" }
  ] })`,
  schema: SaveMemoryInputSchema,
});

export { MemorySizeError };

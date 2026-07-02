import { tool } from "@langchain/core/tools";
import { applyPatch as applyJsonPatch } from "fast-json-patch";
import { z } from "zod";

import { MEMORY_PROFILE_MAX_BYTES } from "@/lib/memory/constants";
import { getProfileDoc, putProfileDoc } from "@/lib/memory/queries";
import { SaveMemoryInputSchema } from "@/lib/memory/validators";
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

// ponytail: build the patch schema by stripping the `save_memory`
// zod wrapper — LangChain's `tool(...)` only accepts the inner object
// shape, not the `{ patches: [...] }` envelope. We re-validate inside
// the impl so we keep both a typed tool surface and the validated input
// we'd lose by inlining the array shape.
const patchSchema = z.preprocess((input) => {
  const parsed = SaveMemoryInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new z.ZodError(parsed.error.issues);
  }
  return parsed.data;
}, z.any());

async function impl(
  input: z.infer<typeof SaveMemoryInputSchema>,
  config?: { configurable?: { userId?: unknown } },
): Promise<string> {
  const userId = extractUserId(config);
  if (!userId) throw new MissingUserIdError();

  const { patches } = SaveMemoryInputSchema.parse(input);

  const current = await getProfileDoc(userId);
  // ponytail: validate replace/remove paths up-front — fast-json-patch
  // silently no-ops on a missing path with the default args, which would
  // let the tool report success on a no-op write. The model would then
  // "remember" a fact it never actually persisted.
  const keyPath = (p: string) => p.replace(/^\//, "");
  for (const patch of patches) {
    if ((patch.op === "replace" || patch.op === "remove") && !(keyPath(patch.path) in current)) {
      throw new MemoryPatchError(`path ${patch.path} not found in profile`);
    }
  }
  // structuredClone first — fast-json-patch mutates in place, which would
  // ripple the cached store value into the next caller.
  const draft = structuredClone(current) as Record<string, unknown>;
  // mutateDocument=true modifies `draft` in place and returns per-op
  // results whose `newValue` is the touched value, NOT the whole doc.
  // We read the document back from `draft` after the apply.
  applyJsonPatch(draft, patches as Parameters<typeof applyJsonPatch>[1], false, true);
  assertProfileSize(draft, MEMORY_PROFILE_MAX_BYTES);
  await putProfileDoc(userId, draft);
  return JSON.stringify({
    ok: true,
    bytes: JSON.stringify(draft).length,
    keyCount: Object.keys(draft).length,
  });
}

export const saveMemoryTool = tool(impl, {
  name: "save_memory",
  description:
    "Persist a structured fact to the user's long-term profile via RFC 6902 JSON Patch operations. Use to record things the user tells you about themselves (role, preferences, project context, wallet address, language, etc). Without these facts, the agent cannot recall the user across conversations. Omit `from`; only `add`, `replace`, and `remove` ops are supported.",
  schema: patchSchema,
});

export { MemorySizeError };

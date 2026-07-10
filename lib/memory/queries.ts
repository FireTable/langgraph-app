import { eq } from "drizzle-orm";

import { store } from "@/backend/store";
import { db } from "@/db/client";
import { account, user } from "@/lib/auth/schema";
import { SummaryEntrySchema, type SummaryEntry } from "@/lib/memory/validators";
import { getThreadTitlesForUser } from "@/lib/threads/queries";

const MEMORY_KEY = "main";
const THREADS_NAMESPACE = "threads";
const MEMORY_NAMESPACE = "memory";

// ponytail: Memory doc is a flat k-v bag at [userId,"memory"] key=main.
// JSONB column accepts any JSON; reads return null when the row is absent.
export type MemoryDoc = Record<string, unknown>;

function memoryNs(userId: string): string[] {
  return [userId, MEMORY_NAMESPACE];
}

function threadsNs(userId: string): string[] {
  return [userId, THREADS_NAMESPACE];
}

export async function getMemoryDoc(userId: string): Promise<MemoryDoc> {
  const item = await store?.get(memoryNs(userId), MEMORY_KEY);
  const value = (item?.value ?? {}) as MemoryDoc;
  return value;
}

export async function putMemoryDoc(userId: string, value: MemoryDoc): Promise<void> {
  await store!.put(memoryNs(userId), MEMORY_KEY, value as Record<string, unknown>);
}

// ponytail: delete = apply RFC 6902 remove patch via the same path
// save_memory uses, so the model can also remove fields. Returns null
// when the row / key is missing — the DELETE handler surfaces 404.
export async function deleteMemoryField(userId: string, key: string): Promise<string | null> {
  const doc = await getMemoryDoc(userId);
  if (!(key in doc)) return null;
  const { [key]: _omitted, ...rest } = doc;
  await putMemoryDoc(userId, rest);
  return key;
}

// ponytail: store.search over the whole [userId,"threads"] prefix is
// fine for MVP — N users × few threads × tens of summaries stays small.
// Add a filter on threadId at the search layer if this grows.
export async function getAllUserSummaries(
  userId: string,
): Promise<Array<{ key: string; value: SummaryEntry }>> {
  const raw = ((await store?.search(threadsNs(userId))) ?? []) as unknown as Array<{
    namespace: string[];
    key: string;
    value: unknown;
  }>;
  const out: Array<{ key: string; value: SummaryEntry }> = [];
  for (const item of raw) {
    const parsed = SummaryEntrySchema.safeParse(item.value);
    if (!parsed.success) continue;
    out.push({ key: item.key, value: parsed.data });
  }
  return out;
}

// ponytail: RECALL_LIMIT was retired — the Memory tab now displays
// every persisted summary for the user. Thread summaries are small
// (a few KB each), so the unbounded read stays well under any
// realistic budget; reintroduce a cap if usage data shows otherwise.
//
// Sort: createdAt ASC (oldest first). The Memory tab's outer thread
// order is driven by the first summary each thread contributes to
// this list — first-seen wins. The frontend useMemo groups by
// threadId and preserves Map insertion order, so a thread whose
// earliest summary is the oldest in the list lands at the top of
// the Memory tab.
//
// Enrichment: each entry carries `threadTitle` (the row from the
// `threads` table — set by renameThreadAgent on the first turn, the
// DEFAULT_THREAD_TITLE "New chat" beforehand). Missing row → null →
// the UI falls back to the raw threadId. Title fetch is deduped per
// distinct threadId so a long thread with N summaries triggers one
// lookup, not N.
export async function getRecentThreadSummaries(
  userId: string,
): Promise<Array<{ key: string; value: SummaryEntry; threadTitle: string | null }>> {
  const all = await getAllUserSummaries(userId);
  const ordered = [...all].sort((a, b) => a.value.createdAt.localeCompare(b.value.createdAt));
  const distinctIds = [...new Set(ordered.map((row) => row.value.threadId))];
  const titles = await getThreadTitlesForUser(userId, distinctIds);
  return ordered.map((row) => ({
    ...row,
    threadTitle: titles.get(row.value.threadId) ?? null,
  }));
}

export async function deleteThreadSummaries(userId: string, threadId: string): Promise<number> {
  const all = await getAllUserSummaries(userId);
  const toDelete = all.filter((s) => s.value.threadId === threadId);
  if (toDelete.length === 0) return 0;
  // ponytail: PostgresStore.batch only handles put/get/search/listNamespaces
  // — a `{ op: "delete" }` entry throws "Unsupported operation type" inside
  // the batch loop (verified at @langchain/langgraph-checkpoint-postgres
  // 1.0.4 /store/index.js:155). The previous code's batch op never
  // actually deleted rows — the API surfaced `deletedCount: toDelete.length`
  // anyway, which is why the Memory tab re-fetch kept showing the same
  // thread summary. Loop store.delete() per key, matching the call pattern
  // the upstream library was written for.
  for (const s of toDelete) {
    await store!.delete(threadsNs(userId), s.key);
  }
  return toDelete.length;
}

// ponytail: thread-scoped read for the chat agent's <threads> block.
// Filters by threadId so cross-thread bleed can't impersonate the
// current chat's compressed history. Sorted oldest-first so the
// model reads them in conversation order (matching how `<memory>`
// surfaces profile + identity).
export async function getThreadSummaries(
  userId: string,
  threadId: string,
): Promise<SummaryEntry[]> {
  const all = await getAllUserSummaries(userId);
  return all
    .filter((s) => s.value.threadId === threadId)
    .sort((a, b) => a.value.sequence - b.value.sequence)
    .map((s) => s.value);
}

// ponytail: writeSummary persists the SummaryEntry bookkeeping row for
// a single in-thread compression pass. The actual compressed text is
// also injected as a HumanMessage into the thread's `messages` channel
// by threadSummarizeNode — the doc here is for the Memory tab list and
// future rehydration (the messageIds array maps Q&A mini-ids back to
// their original BaseMessage.id values).
export async function writeSummary(
  userId: string,
  doc: Omit<SummaryEntry, "createdAt"> & { createdAt?: string },
): Promise<SummaryEntry> {
  const createdAt = doc.createdAt ?? new Date().toISOString();
  const full = { ...doc, createdAt } as SummaryEntry;
  await store!.put(
    threadsNs(userId),
    `${doc.threadId}:${doc.sequence}`,
    full as unknown as Record<string, unknown>,
  );
  return full;
}

// ponytail: we read `idToken` / `accessToken` only to derive a per-provider
// email — the raw tokens never leave this function (FR-020 keeps accountId /
// tokens out of the recall payload). Google's email comes from the OIDC
// idToken; GitHub's from one API call spending the stored access token.
// Filter out better-auth's `"credential"` provider — that's the
// email+password account, not a social login.
export type AuthInfo = {
  name: string | null;
  email: string | null;
  avatar: string | null;
  socials: Array<{ provider: string; email?: string }>;
};

// ponytail: single source of truth for the "auth lookup failed" fallback —
// `.catch(() => EMPTY_AUTH_INFO)` at every call site. Keeps the socials
// element shape (`email?`) in one place so it can't drift.
export const EMPTY_AUTH_INFO: AuthInfo = { name: null, email: null, avatar: null, socials: [] };

// ponytail: read the `email` claim out of an OIDC idToken. Google is OIDC
// so its idToken is a JWT (header.payload.signature) with an email claim.
// We only READ our own stored token, so no signature verify: base64url-
// decode the middle segment. Malformed / missing → undefined, never throws.
function emailFromIdToken(idToken: string | null): string | undefined {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims?.email === "string" ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

// ponytail: GitHub is OAuth2, not OIDC — no idToken to decode. Its email
// lives behind the API, so we spend the user's own stored access token
// (default scope already includes `user:email`) on one GET. Best-effort:
// any failure (revoked token, rate limit, network) → undefined, the row
// just stays email-less. This is the only network hop in getAuthInfo, so
// it rides the recall LRU (getCachedMemory) on the prompt path.
async function fetchGithubEmail(accessToken: string | null): Promise<string | undefined> {
  if (!accessToken) return undefined;
  try {
    const res = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "langgraph-app",
      },
    });
    if (!res.ok) return undefined;
    const emails = (await res.json()) as Array<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;
    const pick =
      emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified) ?? emails[0];
    return typeof pick?.email === "string" ? pick.email : undefined;
  } catch {
    return undefined;
  }
}

export async function getAuthInfo(userId: string): Promise<AuthInfo> {
  const [u] = await db
    .select({ name: user.name, email: user.email, image: user.image })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const accounts = await db
    .select({
      provider: account.providerId,
      idToken: account.idToken,
      accessToken: account.accessToken,
    })
    .from(account)
    .where(eq(account.userId, userId));
  return {
    name: u?.name ?? null,
    email: u?.email ?? null,
    avatar: u?.image ?? null,
    socials: await Promise.all(
      accounts
        .filter((r) => r.provider !== "credential")
        .map(async (r) => {
          const email =
            emailFromIdToken(r.idToken) ??
            (r.provider === "github" ? await fetchGithubEmail(r.accessToken) : undefined);
          return email ? { provider: r.provider, email } : { provider: r.provider };
        }),
    ),
  };
}

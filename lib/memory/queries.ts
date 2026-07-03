import { eq } from "drizzle-orm";

import { store } from "@/backend/store";
import { db } from "@/db/client";
import { account } from "@/lib/auth/schema";
import { SummaryEntrySchema, type SocialAccount, type SummaryEntry } from "@/lib/memory/validators";

const PROFILE_KEY = "main";
const THREADS_NAMESPACE = "threads";
const PROFILE_NAMESPACE = "profile";

// ponytail: Profile doc is a flat k-v bag at [userId,"profile"] key=main.
// JSONB column accepts any JSON; reads return null when the row is absent.
export type ProfileDoc = Record<string, unknown>;

function profileNs(userId: string): string[] {
  return [userId, PROFILE_NAMESPACE];
}

function threadsNs(userId: string): string[] {
  return [userId, THREADS_NAMESPACE];
}

export async function getProfileDoc(userId: string): Promise<ProfileDoc> {
  const item = await store?.get(profileNs(userId), PROFILE_KEY);
  const value = (item?.value ?? {}) as ProfileDoc;
  return value;
}

export async function putProfileDoc(userId: string, value: ProfileDoc): Promise<void> {
  await store!.put(profileNs(userId), PROFILE_KEY, value as Record<string, unknown>);
}

// ponytail: delete = apply RFC 6902 remove patch via the same path
// save_memory uses, so the model can also remove fields. Returns null
// when the row / key is missing — the DELETE handler surfaces 404.
export async function deleteProfileField(userId: string, key: string): Promise<string | null> {
  const doc = await getProfileDoc(userId);
  if (!(key in doc)) return null;
  const { [key]: _omitted, ...rest } = doc;
  await putProfileDoc(userId, rest);
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

export async function getRecentThreadSummaries(
  userId: string,
  limit: number,
): Promise<Array<{ key: string; value: SummaryEntry }>> {
  const all = await getAllUserSummaries(userId);
  return [...all]
    .sort((a, b) => b.value.updatedAt.localeCompare(a.value.updatedAt))
    .slice(0, limit);
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

export async function writeSummary(
  userId: string,
  doc: Omit<SummaryEntry, "updatedAt"> & { updatedAt?: string },
): Promise<SummaryEntry> {
  const updatedAt = doc.updatedAt ?? new Date().toISOString();
  const full = { ...doc, updatedAt } as SummaryEntry;
  await store!.put(
    threadsNs(userId),
    `${doc.threadId}:${doc.sequence}`,
    full as unknown as Record<string, unknown>,
  );
  return full;
}

// ponytail: explicit `.select({ provider: account.providerId })` keeps
// `accountId` / tokens out of the recall payload (FR-020). Filter out
// better-auth's `"credential"` provider — that's the email+password
// account, not a social login; showing it in the Memory view as a
// "linked account" is misleading.
export async function getSocialAccounts(userId: string): Promise<SocialAccount[]> {
  const rows = await db
    .select({ provider: account.providerId })
    .from(account)
    .where(eq(account.userId, userId));
  return rows.filter((r) => r.provider !== "credential").map((r) => ({ provider: r.provider }));
}

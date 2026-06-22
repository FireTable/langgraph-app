import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { user } from "@/lib/auth/schema";

const created: string[] = [];

export async function makeUser(email?: string): Promise<{ id: string; email: string }> {
  const id = `test-${randomUUID()}`;
  const row = { id, email: email ?? `${id}@test.local`, name: "Test User" };
  await db.insert(user).values(row);
  created.push(id);
  return row;
}

export async function cleanupUsers(): Promise<void> {
  if (created.length === 0) return;
  // CASCADE removes session/account/threads too.
  await db.delete(user);
  created.length = 0;
}

// Pre-registered test owner used by query tests that insert threads
// directly. Inserts lazily on first call, then caches.
export const TEST_USER = { id: "test-session-user", email: "session@test.local" };
let ensured = false;
export async function ensureTestUser(): Promise<void> {
  if (ensured) return;
  await db
    .insert(user)
    .values({ id: TEST_USER.id, email: TEST_USER.email, name: "Test Owner" })
    .onConflictDoNothing();
  ensured = true;
}

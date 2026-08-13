"use client";

// ponytail: per-thread canvas UI prefs (currently just open/closed).
// Lives in localStorage so the user doesn't have to re-click the
// toggle after a refresh. Keys are namespaced under `canvas:` so
// other prefs can ride the same root later without colliding.

const KEY_PREFIX = "canvas:";

export function getCanvasOpen(threadId: string | null): boolean {
  if (!threadId) return false;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEY_PREFIX + threadId + ":open") === "1";
  } catch {
    // ponytail: Safari private mode / quota errors throw on getItem;
    // fall through to closed so the toggle still works in-in.
    return false;
  }
}

export function setCanvasOpen(threadId: string | null, open: boolean): void {
  if (!threadId) return;
  if (typeof window === "undefined") return;
  try {
    if (open) {
      window.localStorage.setItem(KEY_PREFIX + threadId + ":open", "1");
    } else {
      window.localStorage.removeItem(KEY_PREFIX + threadId + ":open");
    }
  } catch {
    // swallow — quota / private-mode failure shouldn't break the toggle.
  }
}

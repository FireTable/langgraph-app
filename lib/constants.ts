// Placeholder mainThreadId assigned to a freshly-created "new thread" that
// hasn't been persisted yet. Filter it out before writing to localStorage —
// we don't want to "remember" a thread id that has no backing record on
// the server, otherwise the next page load would try to switchToThread a
// ghost and hit 404.
export const LOCAL_THREAD_PREFIX = "__LOCALID_";

// localStorage key for the active thread id. Must match the string the
// runtime reads on hydration.
export const ACTIVE_THREAD_ID = "ACTIVE_THREAD_ID";

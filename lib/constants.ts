// Placeholder mainThreadId assigned to a freshly-created "new thread" that
// hasn't been persisted yet. Filter it out before writing to localStorage —
// we don't want to "remember" a thread id that has no backing record on
// the server, otherwise the next page load would try to switchToThread a
// ghost and hit 404.
export const LOCAL_THREAD_PREFIX = "__LOCALID_";
export const ACTIVE_THREAD_KEY = "ACTIVE_THREAD_KEY";
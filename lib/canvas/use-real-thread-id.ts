"use client";

import { useAuiState } from "@assistant-ui/react";

// ponytail: aUI's `threads.mainThreadId` is an INTERNAL id that the
// runtime uses to key into `threads.threadItems[]`. The actual id we
// hand to the backend (LangGraph server, /api/canvas/{id}, localStorage
// prefs) lives on the matching `threadItems` entry as `externalId`. In
// the placeholder state (no thread bound to the server yet) the entry
// is missing OR its externalId is null, so we fall back to
// `mainThreadId` itself — which carries the `__LOCAL_<rand>` shape
// that the runtime uses as a stand-in. The same `__LOCAL_` prefix is
// the placeholder sentinel observability uses (see
// components/observability/button.tsx).
//
// Returns null when no real id is available yet, so callers don't
// accidentally feed a placeholder into the canvas API.

export const LOCAL_THREAD_PREFIX = "__LOCAL_";

export function useRealThreadId(): string | null {
  return useAuiState((s) => {
    const item = s.threads.threadItems.find((t) => t.id === s.threads.mainThreadId);
    const candidate = item?.externalId ?? s.threads.mainThreadId;
    return candidate && !candidate.startsWith(LOCAL_THREAD_PREFIX) ? candidate : null;
  });
}

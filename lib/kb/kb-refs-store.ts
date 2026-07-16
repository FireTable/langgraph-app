import { create } from "zustand";

// ponytail: thread-scoped map of file-part URLs (FilePart.data) to
// their ingested kb_document. Populated by app/assistant.tsx's
// useLangGraphRuntime.load() from state.values.kb_refs and read by
// components/assistant-ui/attachment.tsx's UserMessageAttachments.
//
// Why a separate store instead of stuffing kb_refs into the aUI
// runtime's load(): the SDK doesn't surface arbitrary state.values
// keys to runtime consumers — load() only returns messages / uiMessages
// / interrupts. A zustand store keyed by threadId mirrors the pattern
// in lib/attachments/upload-store.ts and lets UserMessageAttachments
// pull the sidecar with a hook.
//
// `activeThreadId` lets components that don't have direct access to
// the runtime's threadId (everything inside `<ThreadPrimitive.Root>`
// is per-thread but the aUI state tree doesn't expose the id cleanly)
// still read the right thread's sidecar. We update it from the
// `onThreadIdChange` callback in app/assistant.tsx so it's always
// in sync with the URL.

type KbRefMarker = { docId: string; attachmentId?: string };

// ponytail: split into two slices — refsByThread (per-thread cache)
// and activeThreadId (the thread currently visible). zustand can't
// represent a Record + sibling scalar cleanly because the index
// signature eats the scalar slot, so we keep them as parallel keys.
type KbRefsStore = {
  refsByThread: Record<string, Record<string, KbRefMarker>>;
  activeThreadId: string | null;
};

export const useKbRefsStore = create<KbRefsStore>(() => ({
  refsByThread: {},
  activeThreadId: null,
}));

export function setKbRefsForThread(threadId: string, refs: Record<string, KbRefMarker>): void {
  useKbRefsStore.setState((s) => ({
    ...s,
    refsByThread: { ...s.refsByThread, [threadId]: refs },
  }));
}

export function clearKbRefsForThread(threadId: string): void {
  useKbRefsStore.setState((s) => {
    if (!(threadId in s.refsByThread)) return s;
    const next = { ...s.refsByThread };
    delete next[threadId];
    return { ...s, refsByThread: next };
  });
}

export function setActiveKbRefsThread(threadId: string | null): void {
  useKbRefsStore.setState((s) =>
    s.activeThreadId === threadId ? s : { ...s, activeThreadId: threadId },
  );
}

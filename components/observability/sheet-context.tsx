// ponytail: singleton sheet. button calls useOpenObservabilitySheet().open()
// from anywhere in the tree; <ObservabilitySheet /> mounted once at ThreadRoot
// handles the fetch + render. Keeps the panel out of the per-message render
// path so a long thread doesn't mount N sheets and N fetches.
"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type SheetState = {
  open: boolean;
  threadId: string | null;
  parentMessageId: string | null;
};

type SheetControls = {
  open: (input: { threadId: string; parentMessageId: string | null }) => void;
  close: () => void;
  setOpen: (open: boolean) => void;
  state: SheetState;
};

const ObservabilitySheetContext = createContext<SheetControls | null>(null);

export function ObservabilitySheetProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SheetState>({
    open: false,
    threadId: null,
    parentMessageId: null,
  });

  const open = useCallback((input: { threadId: string; parentMessageId: string | null }) => {
    setState({
      open: true,
      threadId: input.threadId,
      parentMessageId: input.parentMessageId,
    });
  }, []);
  const close = useCallback(() => {
    setState((prev) => ({ ...prev, open: false }));
  }, []);
  const setOpen = useCallback((next: boolean) => {
    setState((prev) => (next ? prev : { ...prev, open: false }));
  }, []);

  const value = useMemo(() => ({ state, open, close, setOpen }), [state, open, close, setOpen]);
  return (
    <ObservabilitySheetContext.Provider value={value}>
      {children}
    </ObservabilitySheetContext.Provider>
  );
}

export function useOpenObservabilitySheet(): (input: {
  threadId: string;
  parentMessageId: string | null;
}) => void {
  const ctx = useContext(ObservabilitySheetContext);
  if (!ctx) throw new Error("useOpenObservabilitySheet outside ObservabilitySheetProvider");
  return ctx.open;
}

export function useObservabilitySheetState(): SheetState & { setOpen: (open: boolean) => void } {
  const ctx = useContext(ObservabilitySheetContext);
  if (!ctx) throw new Error("useObservabilitySheetState outside ObservabilitySheetProvider");
  const { state, setOpen } = ctx;
  return { ...state, setOpen };
}

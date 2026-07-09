import { create } from "zustand";

// ponytail: counter-based active flag, not a boolean. Multiple
// attachments upload via Promise.all(adapter.send) inside the SDK
// composer, so begin/end pairs interleave. A boolean would flicker:
// attachment A's end() clears the flag while attachment B's begin()
// is still in flight. Counter balances the pairs naturally.
//
// Read pattern: `useUploadStore((s) => s.count > 0)` re-renders only
// when the boolean flips, not on every increment — zustand's selector
// does referential equality on the return value.

type UploadStore = { count: number };

export const useUploadStore = create<UploadStore>(() => ({ count: 0 }));

export const beginUpload = () => useUploadStore.setState((s) => ({ count: s.count + 1 }));

export const endUpload = () =>
  useUploadStore.setState((s) => ({ count: Math.max(0, s.count - 1) }));

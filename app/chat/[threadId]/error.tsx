"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// ponytail: fall back to /chat whenever this segment can't render.
// Two failure modes hit this in practice:
//   1. Turbopack "Entry not available in the store" — a Next 16 dev-mode
//      cache miss on a dynamic param we haven't built yet. Replacing
//      with the root URL lands us in the well-trodden /chat path
//      where the runtime's constructor creates a fresh placeholder.
//   2. Any other segment-level render error (auth check throw, RSC
//      serialize hiccup, etc.). Same fallback.
// `error`/`reset` are Next-mandated props; we don't surface the
// error to the user — by the time this mounts we've already decided
// the URL is bogus, so just navigate.
export default function ChatThreadError({
  error: _error,
  reset: _reset,
}: {
  error: Error;
  reset: () => void;
}) {
  const router = useRouter();
  useEffect(() => {
    router.replace("/chat");
  }, [router]);
  return null;
}

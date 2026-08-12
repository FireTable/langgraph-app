"use client";

import dynamic from "next/dynamic";
import { useState, type FC, type ReactNode } from "react";
import { MessageCircleIcon, PanelRightCloseIcon } from "lucide-react";

import { CanvasProvider } from "@/lib/canvas/context";
import { cn } from "@/lib/utils";

// ponytail: full-canvas mode with a floating chat overlay. Canvas
// fills the entire area; the chat panel docks to the right as a
// translucent card (backdrop-blur so the canvas underneath shows
// through). Two control anchors depending on state:
//   - chat open  → collapse icon lives INSIDE the card at its
//     bottom-left (close-affordance attached to the surface it
//     controls).
//   - chat closed → chat-bubble icon floats at the viewport's
//     bottom-right so the user can reopen the panel.
//
// Both the card and the bubble stay mounted; the open/close flip
// transitions opacity + transform. We could have used
// `tw-animate-css` exit keyframes, but those reset the element to
// its base state after the 200ms — keeping both elements mounted
// means a stale "visible" card lingers unless we pin the final
// state via fill-mode, which gets brittle. A plain `transition`
// on the same props does the right thing in both directions
// without a keyframe engine.

const CanvasEditor = dynamic(
  () => import("./CanvasEditor").then((m) => ({ default: m.CanvasEditor })),
  { ssr: false, loading: () => <CanvasFallback /> },
);

function CanvasFallback() {
  return (
    <div className="bg-muted/30 flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      Loading canvas…
    </div>
  );
}

const CHAT_PANEL_WIDTH = "w-[360px] sm:w-[400px]";

type Props = {
  threadId: string | null;
  threadPanel: ReactNode;
};

export const CanvasSplitLayout: FC<Props> = ({ threadId, threadPanel }) => {
  const [chatOpen, setChatOpen] = useState(true);

  if (!threadId) {
    return <div className="h-full w-full">{threadPanel}</div>;
  }

  return (
    <CanvasProvider>
      <div className="relative h-full w-full">
        <div className="absolute inset-0">
          <CanvasEditor key={threadId} threadId={threadId} />
        </div>

        {/*
          Chat card. translate-x-full + opacity-0 when closed so the
          slide-out reads as a single motion; pointer-events-none so
          the closed card doesn't intercept canvas clicks. ease-out
          matches "user-initiated close" — fast start, soft landing.
        */}
        <div
          aria-hidden={!chatOpen}
          className={cn(
            "absolute right-3 top-3 bottom-3 flex flex-col overflow-hidden rounded-xl",
            "border border-border/60 bg-card/70 backdrop-blur-md shadow-lg",
            CHAT_PANEL_WIDTH,
            "transition-all duration-200 ease-out",
            chatOpen
              ? "translate-x-0 opacity-100"
              : "translate-x-full opacity-0 pointer-events-none",
          )}
        >
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {threadPanel}

            {/*
              Collapse control lives inside the card so it rides with
              the chat. Anchored bottom-left of the inner wrapper
              (= card), z-110 so it sits above the scroll area's edge
              decorations and the card's own backdrop-blur layer.
            */}
            <button
              type="button"
              onClick={() => setChatOpen(false)}
              className={cn(
                "absolute bottom-1.25 left-1.25 z-110 inline-flex size-5 items-center justify-center",
                "rounded-md border border-border/40 bg-card/60 text-muted-foreground backdrop-blur-sm border-none",
                "transition-colors hover:bg-card hover:text-foreground",
              )}
              aria-label="Collapse chat panel"
            >
              <PanelRightCloseIcon className="size-3.5" />
            </button>
          </div>
        </div>

        {/*
          Bubble button (collapsed state). Same always-mounted
          trick: scale-in / fade-in when becoming visible,
          scale-out / fade-out when hidden. ease-out keeps it
          punchy on open.
        */}
        <button
          type="button"
          onClick={() => setChatOpen(true)}
          aria-hidden={chatOpen}
          tabIndex={chatOpen ? -1 : 0}
          className={cn(
            "absolute bottom-3 right-3 z-20 inline-flex size-10 items-center justify-center",
            "rounded-full border border-border/60 bg-card/80 text-foreground shadow-md backdrop-blur-md transition-colors hover:bg-card",
            "transition-all duration-200 ease-out",
            chatOpen ? "scale-95 opacity-0 pointer-events-none" : "scale-100 opacity-100",
          )}
          aria-label="Open chat panel"
        >
          <MessageCircleIcon className="size-4" />
        </button>
      </div>
    </CanvasProvider>
  );
};

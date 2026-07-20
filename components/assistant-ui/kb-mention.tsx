"use client";

import {
  ComposerPrimitive,
  unstable_useMentionAdapter,
  unstable_useTriggerPopoverScopeContextOptional,
  type Unstable_Mention,
  type Unstable_MentionCategory,
} from "@assistant-ui/react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  SparklesIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { kbMentionFormatter } from "./kb-mention-formatter";

// ponytail: @-mention adapter for KB folders + docs (issue #13 v3).
// Reads `/api/kb/documents?mention=1` (returns folders grouped with
// their success-only docs) and exposes them as categories for
// assistant-ui's `TriggerPopover`. Each folder is a category; each
// category's items are docs in that folder. The first item in each
// category is a synthetic `type: "kb-folder"` row labeled "All in
// <folder>" — picking it inserts a `:kb-folder[label]{name=id}`
// directive that the backend resolver expands to every success doc.
//
// Why the synthetic row instead of a header button: aUI's
// `TriggerPopoverItem` already covers selection + keyboard nav +
// directive insertion. A custom header button would mean re-implementing
// the directive formatter, ARIA wiring, and keyboard nav — pure
// overhead. Putting it as the first item gives us the same UX with
// the existing primitives.

type Doc = { id: string; title: string; status: string };
type FolderGroup = {
  id: string;
  name: string;
  docCount: number;
  docs: Doc[];
};
type MentionPayload = { folders?: FolderGroup[] };

async function fetchMentionPayload(): Promise<FolderGroup[]> {
  const res = await fetch("/api/kb/documents?mention=1", { credentials: "include" });
  if (!res.ok) return [];
  const body = (await res.json()) as MentionPayload;
  return body.folders ?? [];
}

function KbDocIcon({ className }: { className?: string }) {
  return <FileTextIcon className={className} />;
}

function KbFolderIcon({ className }: { className?: string }) {
  return <FolderIcon className={className} />;
}

function KbAllInFolderIcon({ className }: { className?: string }) {
  return <SparklesIcon className={className} />;
}

const KB_ICON_MAP = {
  "kb-doc": KbDocIcon,
  "kb-folder": KbFolderIcon,
  "kb-folder-all": KbAllInFolderIcon,
};

// formatMentionCategories: each folder becomes its own category.
// The first item in each category is a synthetic "kb-folder" row that
// lets the user mention the entire folder. The remaining items are
// individual docs ("kb-document").
export function formatMentionCategories(
  folders: readonly FolderGroup[],
): Unstable_MentionCategory[] {
  return folders.map((f) => ({
    id: f.id,
    label: f.name,
    items: [
      // First item: select the whole folder
      {
        id: f.id,
        type: "kb-folder",
        label: f.name,
        description: `All ${f.docCount} doc${f.docCount === 1 ? "" : "s"}`,
        icon: "kb-folder",
        metadata: { folderId: f.id, folderName: f.name },
      } satisfies Unstable_Mention,
      // Subsequent items: individual documents
      ...f.docs.map(
        (d): Unstable_Mention => ({
          id: d.id,
          type: "kb-document",
          label: d.title,
          description: d.status,
          icon: "kb-doc",
          metadata: { docId: d.id, parentFolderId: f.id },
        }),
      ),
    ],
  }));
}

// ponytail: KB popover hook — bundles all state + side effects.
// Returns the aUI adapter bundle plus folders/isLoading/refetch so
// callers can either use the pre-built popover or compose their own.
export function useKbMention() {
  const [folders, setFolders] = useState<FolderGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // ponytail: optimistic update — only the FIRST fetch shows the
  // skeleton. Subsequent refetches (popover reopens) keep the existing
  // data on screen and update silently in the background. Avoids the
  // skeleton flash every time the user types `@` after the first time.
  const hasInitialDataRef = useRef(false);

  const refetch = useCallback(() => {
    let cancelled = false;
    if (!hasInitialDataRef.current) {
      setIsLoading(true);
    }
    fetchMentionPayload()
      .then((g) => {
        if (!cancelled) {
          setFolders(g);
          setError(null);
          hasInitialDataRef.current = true;
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ponytail: no mount refetch — the first popover open drives the
  // fetch via PopoverOpenWatcher. The skeleton guard (scope.open check
  // in KbMentionSkeleton) keeps the initial isLoading=true from
  // rendering an inline skeleton in the composer root.

  // ponytail: convert API payload to aUI's categories shape.
  // Each folder is its own top-level category; its docs are category items.
  // The library auto-manages navigation: show categories → click folder →
  // load category items (docs). TriggerPopoverBack returns to folder list.
  const categories = useMemo(() => formatMentionCategories(folders), [folders]);

  const bundle = unstable_useMentionAdapter({
    categories,
    iconMap: KB_ICON_MAP,
    fallbackIcon: KbFolderIcon,
    formatter: kbMentionFormatter,
  });

  // ponytail: aUI strips items before passing categories to the
  // popover UI (Unstable_TriggerCategory only has id+label). Pass the
  // per-folder docCount separately so the dropdown header can read
  // "Research · 5 docs". memoized — bare object literal would defeat
  // React.memo on KbMentionPopover.
  const docCountByFolderId = useMemo(() => {
    const out: Record<string, number> = {};
    for (const f of folders) out[f.id] = f.docCount;
    return out;
  }, [folders]);

  return { bundle, folders, error, isLoading, docCountByFolderId, refetch };
}

// ponytail: debounce onOpen. aUI's resource can flicker scope.open
// during a close (true → false → true → false) — the bare guard
// `if (isOpen && !wasOpenRef.current)` fires onOpen on every false→true
// transition, so a single close can trigger two refetches. We hold
// onOpen for 100ms of stable-open before firing; if scope.open flips
// back to false in that window, the timeout is cleared and onOpen
// never runs.
const PopoverOpenWatcher = ({ onOpen }: { onOpen: () => void }) => {
  const scope = unstable_useTriggerPopoverScopeContextOptional();
  const wasOpenRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const isOpen = scope?.open ?? false;

    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (isOpen) {
      if (!wasOpenRef.current) {
        timeoutRef.current = setTimeout(() => {
          wasOpenRef.current = true;
          timeoutRef.current = null;
          onOpen();
        }, 100);
      }
    } else {
      wasOpenRef.current = false;
    }
  }, [scope?.open, onOpen]);

  useEffect(
    () => () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    },
    [],
  );

  return null;
};

// Renders the popover header:
// - When a folder is active (drill-down): shows back button + folder name
// - When at root level: shows "Knowledge Base" title
const KbMentionPopoverHeader = () => {
  const scope = unstable_useTriggerPopoverScopeContextOptional();
  if (!scope || !scope.open) return null;

  if (scope.activeCategoryId) {
    return (
      <ComposerPrimitive.Unstable_TriggerPopoverBack className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-bold capitalize tracking-wider text-muted-foreground/60 border-b border-border/40 mb-1 hover:text-foreground transition-colors cursor-pointer">
        <ChevronLeftIcon className="size-3" />
        <span>{"Back"}</span>
      </ComposerPrimitive.Unstable_TriggerPopoverBack>
    );
  }

  return (
    <div className="px-2.5 py-1.5 text-[10px] font-bold capitalize tracking-wider text-muted-foreground/60 border-b border-border/40 mb-1">
      Knowledge Base
    </div>
  );
};

// ponytail: must guard on scope.open — aUI's Unstable_TriggerPopover
// renders children WITHOUT the positioning wrapper when closed
// (`t15 = open ? <div/> : children` in TriggerPopover.js). The popover
// is portaled to .aui-composer-root (flex-col), so an unguarded
// skeleton would render as an in-flow child there and push the input
// up by ~30px on every popover close. Same pattern as
// KbMentionPopoverHeader / TriggerPopoverCategories / TriggerPopoverItems.
const KbMentionSkeleton = () => {
  const scope = unstable_useTriggerPopoverScopeContextOptional();
  if (!scope?.open) return null;
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg">
      <div className="size-3.5 shrink-0 rounded bg-muted animate-pulse" />
      <div className="h-3 w-32 rounded bg-muted animate-pulse" />
    </div>
  );
};

// ponytail: wrapped in React.memo + self-contained. The parent Composer
// re-renders on every aUI store update (typing / running / disabled), so
// without memo this component re-runs the JSX construction, the portal
// call, and the PopoverOpenWatcher's effect chain on every store tick.
// State lives inside (useKbMention) — no props to thread through. Memo
// still helps: external re-renders without internal state changes skip.
export const KbMentionPopover = memo(function KbMentionPopover() {
  const { bundle, docCountByFolderId, folders, isLoading, refetch } = useKbMention();
  const [portalContainer, setPortalContainer] = useState<Element | null>(null);

  useEffect(() => {
    const container = document.querySelector(".aui-composer-root");
    setPortalContainer(container);
  }, []);

  if (!isLoading && (!folders || folders.length === 0)) return null;

  // ponytail: wrap the popover JSX in useMemo. aUI's Unstable_TriggerPopover
  // toggles a wrapper div on open/close (`t15 = open ? <div/> : children`),
  // and React treats a parent-type change as unmount + remount of the
  // subtree. That remount resets the PopoverOpenWatcher's wasOpenRef and
  // fires onOpen on the next render. Keeping the children reference stable
  // (memoized on the real content deps) means the wrapper doesn't toggle
  // when the popover re-renders for unrelated reasons — only when the
  // content actually changes.
  const popoverNode = useMemo(
    () => (
      <ComposerPrimitive.Unstable_TriggerPopover
        char="@"
        adapter={bundle.adapter}
        className="aui-composer-trigger-popover bg-popover text-popover-foreground absolute bottom-full left-0 z-50 mb-4 w-64 overflow-hidden rounded-xl border bg-background p-1 shadow-lg flex flex-col gap-0.5"
      >
        <PopoverOpenWatcher onOpen={refetch} />
        {/* Directive must always be mounted so the popover can open when @ is typed */}
        <ComposerPrimitive.Unstable_TriggerPopover.Directive
          formatter={bundle.directive.formatter}
        />
        <KbMentionPopoverHeader />
        {isLoading ? (
          <KbMentionSkeleton />
        ) : (
          <>
            <ComposerPrimitive.Unstable_TriggerPopoverCategories>
              {(categories) =>
                categories.map((category) => (
                  <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem
                    key={category.id}
                    categoryId={category.id}
                    className="hover:bg-accent focus:bg-accent data-[highlighted]:bg-accent flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-xs transition-colors outline-none rounded-lg text-left"
                  >
                    <span className="flex w-full min-w-0 items-center gap-2">
                      <FolderIcon className="text-muted-foreground size-3.5 shrink-0" />
                      <span className="truncate min-w-0 font-medium text-foreground/90">
                        {category.label}
                      </span>
                      <span className="text-muted-foreground/60 ml-auto shrink-0 text-[10px]">
                        {docCountByFolderId[category.id] ?? 0} docs
                      </span>
                      <ChevronRightIcon className="text-muted-foreground size-3 shrink-0" />
                    </span>
                  </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
                ))
              }
            </ComposerPrimitive.Unstable_TriggerPopoverCategories>
            <ComposerPrimitive.Unstable_TriggerPopoverItems>
              {(items) =>
                items.map((item, index) => (
                  <ComposerPrimitive.Unstable_TriggerPopoverItem
                    key={`${item.type}:${item.id}`}
                    item={item}
                    index={index}
                    className={cn(
                      "hover:bg-accent focus:bg-accent data-[highlighted]:bg-accent flex w-full cursor-pointer flex-col items-start gap-0.5 px-2.5 py-1.5 text-xs text-start transition-colors outline-none rounded-lg",
                      item.type === "kb-document" && "pl-6",
                    )}
                  >
                    <span className="flex w-full min-w-0 items-center gap-2">
                      {item.type === "kb-folder" ? (
                        <FolderIcon className="text-indigo-500 size-3.5 shrink-0" />
                      ) : (
                        <FileTextIcon className="text-emerald-500 size-3.5 shrink-0" />
                      )}
                      <span
                        className={cn(
                          "truncate min-w-0 font-medium text-foreground/90",
                          item.type === "kb-document" && "text-foreground/70 font-normal",
                        )}
                      >
                        {item.label}
                      </span>
                      {item.description && item.type === "kb-folder" ? (
                        <span className="text-muted-foreground/60 shrink-0 text-[10px]">
                          {item.description}
                        </span>
                      ) : null}
                    </span>
                  </ComposerPrimitive.Unstable_TriggerPopoverItem>
                ))
              }
            </ComposerPrimitive.Unstable_TriggerPopoverItems>
          </>
        )}
      </ComposerPrimitive.Unstable_TriggerPopover>
    ),
    [bundle.adapter, bundle.directive.formatter, isLoading, docCountByFolderId, refetch],
  );

  if (!portalContainer) return null;

  return createPortal(popoverNode, portalContainer);
});

// ponytail: helper hook for components that need the folder payload
// directly (e.g. the DirectiveText chip renderer can use folder icons
// when the directive type is "kb-folder").
export type { FolderGroup, Doc };

"use client";

// ponytail: singleton <Sheet/> mounted at ThreadRoot. Subscribes to the
// sheet-context to know which thread to load; holds the fetch lifecycle
// (was previously inlined in button.tsx → per-message N-fold duplication).
import { useEffect, useState } from "react";
import type { FC } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAuiState } from "@assistant-ui/react";
import type { SpanData } from "@assistant-ui/react-o11y";
import { ObservabilityPanel } from "@/components/observability/panel";
import { transformCapturedToSpanData } from "@/lib/observability/transform";
import { useObservabilitySheetState } from "@/components/observability/sheet-context";
import type { CapturedSpan } from "@/backend/observability/callback-collector";

const LOCAL_THREAD_PREFIX = "__LOCAL_";

export const ObservabilitySheet: FC = () => {
  const { open, threadId, parentMessageId, setOpen } = useObservabilitySheetState();
  const [spans, setSpans] = useState<CapturedSpan[]>([]);
  const [spanData, setSpanData] = useState<SpanData[]>([]);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ponytail: when the sheet is closed we still track the latest threadId
  // the user clicked on (saved in sheet-context state) so a re-open on the
  // same thread shows cached data without a round trip. Reset load flags
  // when the active threadId changes.
  const auiThreadId = useAuiState((s) => {
    const item = s.threads.threadItems.find((t) => t.id === s.threads.mainThreadId);
    const candidate = item?.externalId ?? s.threads.mainThreadId;
    return candidate && !candidate.startsWith(LOCAL_THREAD_PREFIX) ? candidate : null;
  });

  useEffect(() => {
    if (!open || !threadId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // ponytail: filtered route takes the path segment
    // `/api/threads/<id>/observability/<parentMessageId>` so the btree
    // index observability_spans_thread_parent_started_idx serves it.
    // When the user clicks an older message whose id isn't captured
    // in any span (no currentParentMessageId on the outer chain),
    // parentMessageId is null and we fall back to the un-filtered
    // route — the panel still renders, just with the merged history.
    const path = parentMessageId
      ? `/api/threads/${threadId}/observability/${encodeURIComponent(parentMessageId)}`
      : `/api/threads/${threadId}/observability`;
    void (async () => {
      try {
        const res = await fetch(path, { credentials: "include" });
        if (cancelled) return;
        if (!res.ok) {
          setError(`Failed to load (${res.status})`);
          return;
        }
        const body = (await res.json()) as {
          thread_id: string;
          retention_days: number;
          parent_message_id?: string;
          spans: CapturedSpan[];
        };
        setSpans(body.spans);
        setSpanData(transformCapturedToSpanData(body.spans));
        setRetentionDays(body.retention_days);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, threadId, parentMessageId]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="flex w-[50vw] min-w-[40rem] max-w-[1200px] flex-col gap-4 overflow-hidden p-6"
      >
        <SheetHeader>
          <div className="flex items-center justify-between gap-3">
            <SheetTitle>Observability</SheetTitle>
            {retentionDays !== null && (
              <span className="text-muted-foreground text-xs">
                spans 保留 {retentionDays} 天,超过 {retentionDays} 天的数据将在下次 retention
                清理时删除
              </span>
            )}
          </div>
        </SheetHeader>
        {auiThreadId && threadId && auiThreadId !== threadId ? (
          <div className="text-muted-foreground text-xs">
            当前对话已切换,点击"关闭"后再次进入查看实时数据
          </div>
        ) : null}
        {error ? (
          <div className="text-destructive text-sm" role="alert">
            {error}
          </div>
        ) : loading && !error ? (
          <div className="text-muted-foreground text-sm">Loading…</div>
        ) : !threadId ? (
          <div className="text-muted-foreground text-sm">无对话可查看</div>
        ) : (
          <ObservabilityPanel spans={spanData} rawSpans={spans} />
        )}
      </SheetContent>
    </Sheet>
  );
};

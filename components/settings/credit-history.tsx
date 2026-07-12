"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { CreditSummarySection } from "@/components/credit/credit-summary-card";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

type Call = {
  id: string;
  providerId: string;
  modelName: string;
  agentName: string;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  status: "success" | "error";
  errorMessage: string | null;
  createdAt: string;
};

type Page = { calls: Call[]; total: number };

async function fetchPage({
  limit,
  offset,
  signal,
}: {
  limit: number;
  offset: number;
  signal: AbortSignal;
}): Promise<Page> {
  const url = new URL("/api/credit/history", window.location.origin);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  const res = await fetch(url.toString(), { signal });
  if (!res.ok) throw new Error(`Failed to load history (${res.status})`);
  return (await res.json()) as Page;
}

function StatusBadge({ status }: { status: Call["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        status === "success"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "bg-destructive/10 text-destructive",
      )}
    >
      {status}
    </span>
  );
}

function AgentChip({ agent }: { agent: string }) {
  return (
    <span className="bg-muted text-foreground inline-flex items-center rounded-md px-2 py-0.5 font-mono text-xs">
      {agent}
    </span>
  );
}

function formatCredits(credits: number): string {
  return credits.toFixed(4);
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return format(d, "yyyy-MM-dd HH:mm:ss");
}

function EmptyState() {
  return (
    <div className="p-8 text-center">
      <p className="mb-1 text-sm font-medium">No calls yet</p>
      <p className="text-muted-foreground mx-auto max-w-xs text-xs leading-relaxed">
        Start chatting to see your usage here.
      </p>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="p-6 text-center" role="alert">
      <p className="text-destructive mb-3 text-sm">Couldn&apos;t load history. Try again.</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function CreditHistory({ className }: { className?: string }) {
  const query = useInfiniteQuery({
    queryKey: ["credit-history"],
    queryFn: ({ pageParam = 0, signal }) =>
      fetchPage({ limit: PAGE_SIZE, offset: pageParam, signal }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.calls.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });

  const calls = query.data?.pages.flatMap((page) => page.calls) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const isInitialLoading = query.isLoading;
  const isLoadingMore = query.isFetchingNextPage;
  const hasMore = query.hasNextPage ?? false;

  return (
    <div className="flex flex-col gap-8">
      <CreditSummarySection />
      <section>
        <h2 className="mb-1 text-sm font-semibold">Call history</h2>
        <p className="text-muted-foreground mb-3 text-xs leading-relaxed">
          Every LLM call charged to your account, most recent first. Failed calls show their error.
        </p>
        <Card className={cn("p-0", className)}>
          <CardContent className="p-0">
            {query.isError ? (
              <ErrorState onRetry={() => void query.refetch()} />
            ) : isInitialLoading ? (
              <div className="p-8 text-center">
                <p className="text-muted-foreground text-sm">Loading your call history…</p>
              </div>
            ) : calls.length === 0 ? (
              <EmptyState />
            ) : (
              <>
                {/* Desktop / wide table */}
                <div className="hidden md:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-muted-foreground border-b text-xs">
                        <th className="px-4 py-2 text-left font-medium">LLM</th>
                        <th className="px-4 py-2 text-left font-medium">When</th>
                        <th className="px-4 py-2 text-left font-medium">Model</th>
                        <th className="px-4 py-2 text-right font-medium">In / Out tokens</th>
                        <th className="px-4 py-2 text-right font-medium">Credits</th>
                        <th className="px-4 py-2 text-left font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {calls.map((call) => (
                        <tr key={call.id} className="border-b last:border-b-0">
                          <td className="px-4 py-2">
                            <AgentChip agent={call.agentName} />
                          </td>
                          <td className="text-muted-foreground px-4 py-2 text-xs tabular-nums">
                            {formatTimestamp(call.createdAt)}
                          </td>
                          <td className="text-muted-foreground px-4 py-2 font-mono text-xs">
                            {call.modelName}
                          </td>
                          <td className="text-muted-foreground px-4 py-2 text-right tabular-nums">
                            {call.inputTokens.toLocaleString()} /{" "}
                            {call.outputTokens.toLocaleString()}
                          </td>
                          <td className="px-4 py-2 text-right font-mono tabular-nums">
                            {formatCredits(call.credits)}
                          </td>
                          <td className="px-4 py-2">
                            <StatusBadge status={call.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Mobile / narrow: stacked rows */}
                <div className="md:hidden">
                  {calls.map((call, idx) => (
                    <div key={call.id}>
                      {idx > 0 && <Separator />}
                      <div className="space-y-1.5 px-4 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <AgentChip agent={call.agentName} />
                          <StatusBadge status={call.status} />
                        </div>
                        <div className="text-muted-foreground text-xs tabular-nums">
                          {formatTimestamp(call.createdAt)} · {call.modelName}
                        </div>
                        <div className="text-muted-foreground text-xs tabular-nums">
                          {call.inputTokens.toLocaleString()} in /{" "}
                          {call.outputTokens.toLocaleString()} out
                        </div>
                        <div className="font-mono text-xs tabular-nums">
                          {formatCredits(call.credits)} credits
                        </div>
                        {call.status === "error" && call.errorMessage ? (
                          <div className="text-destructive text-xs">{call.errorMessage}</div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
                {hasMore ? (
                  <div className="px-4 py-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void query.fetchNextPage()}
                      disabled={isLoadingMore}
                      aria-busy={isLoadingMore}
                    >
                      {isLoadingMore ? "Loading…" : `Load more (${calls.length} of ${total})`}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

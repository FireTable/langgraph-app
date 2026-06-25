"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

import { ToolCardSkeleton } from "@/components/tool-ui/tool-card-skeleton";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";
import { cn } from "@/lib/utils";

type Coin = {
  id: string;
  symbol: string;
  name: string;
  image: string;
  current_price: number;
  market_cap: number;
  market_cap_rank: number;
  price_change_percentage_24h: number;
  sparkline: number[];
};

type Result = { success: true; coins: Coin[] } | { success: false; error: string };

type Args = { ids: string[]; vs_currency?: string };

type Parsed =
  | { kind: "loading" }
  | { kind: "ok"; coins: Coin[]; vs_currency: string }
  | { kind: "error"; message: string };

function parse(raw: unknown, vsCurrency: string): Parsed {
  const obj = unwrapToolResult<Result>(raw);
  if (!obj) return { kind: "loading" };
  if (obj.success === true) return { kind: "ok", coins: obj.coins, vs_currency: vsCurrency };
  if (obj.success === false) return { kind: "error", message: obj.error };
  return { kind: "loading" };
}

function formatPrice(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: value < 1 ? 6 : 2,
  }).format(value);
}

function formatPct(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function Sparkline({ values, positive }: { values: number[]; positive: boolean }) {
  if (!values || values.length < 2) return null;
  const w = 80;
  const h = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = w / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * stepX).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={cn("shrink-0", positive ? "stroke-emerald-500" : "stroke-rose-500")}
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export const CryptoPriceCard: ToolCallMessagePartComponent<Args, Result> = ({ result, args }) => {
  const vsCurrency = args?.vs_currency ?? "usd";
  const parsed = parse(result, vsCurrency);

  if (parsed.kind === "loading") {
    return <ToolCardSkeleton label="Fetching prices…" />;
  }
  if (parsed.kind === "error") {
    return (
      <div className="text-destructive my-2 text-xs">Couldn't fetch prices: {parsed.message}</div>
    );
  }
  if (parsed.coins.length === 0) {
    return <div className="text-muted-foreground my-2 text-xs">No coins matched those ids.</div>;
  }

  return (
    <div
      data-slot="crypto-price-card"
      className="border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border"
    >
      <ul className="divide-border/40 divide-y">
        {parsed.coins.map((c) => {
          const positive = c.price_change_percentage_24h >= 0;
          return (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2.5">
              {c.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.image} alt="" className="size-7 shrink-0 rounded-full" loading="lazy" />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{c.symbol}</span>
                  <span className="text-muted-foreground truncate text-xs">{c.name}</span>
                </div>
                <div className="text-muted-foreground mt-0.5 font-mono text-[10px]">
                  rank #{c.market_cap_rank}
                </div>
              </div>
              <Sparkline values={c.sparkline} positive={positive} />
              <div className="text-right">
                <div className="text-sm font-semibold tabular-nums">
                  {formatPrice(c.current_price, parsed.vs_currency)}
                </div>
                <div
                  className={cn(
                    "mt-0.5 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
                    positive
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "bg-rose-500/10 text-rose-600 dark:text-rose-400",
                  )}
                >
                  {positive ? (
                    <ArrowUpIcon className="size-2.5" />
                  ) : (
                    <ArrowDownIcon className="size-2.5" />
                  )}
                  {formatPct(c.price_change_percentage_24h)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

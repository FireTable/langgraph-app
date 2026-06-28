"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  ImagesIcon,
  ImageOffIcon,
  PlayCircleIcon,
  XIcon,
} from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { ToolCardSkeleton } from "@/components/tool-ui/tool-card-skeleton";
import { AddressOrHash } from "@/components/ui/address-or-hash";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";
import { NFT_GALLERY_COLLAPSED_STORAGE_KEY } from "@/lib/constants";
import { cn } from "@/lib/utils";

type Nft = {
  contractAddress: string;
  contractName: string;
  collectionName: string | null;
  collectionSlug: string | null;
  contractImageUrl: string | null;
  network: string;
  tokenId: string;
  tokenType: string;
  name: string;
  thumbnailUrl: string | null;
  cachedUrl: string | null;
  contentType: string | null;
  balance: string;
  totalSupply: string | null;
  floorPriceEth: number | null;
};

type Result =
  | { success: true; address: string; totalCount: number; nfts: Nft[] }
  | { success: false; error: string };

type Args = { address: string };

function parse(raw: unknown): Result | null {
  return unwrapToolResult<Result>(raw);
}

const NETWORK_LABEL: Record<string, string> = {
  "eth-mainnet": "Ethereum",
  "arb-mainnet": "Arbitrum",
  "opt-mainnet": "Optimism",
  "base-mainnet": "Base",
  "polygon-mainnet": "Polygon",
};

const NETWORK_SLUG_FOR_OPENSEA: Record<string, string> = {
  "eth-mainnet": "ethereum",
  "arb-mainnet": "arbitrum",
  "opt-mainnet": "optimism",
  "base-mainnet": "base",
  "polygon-mainnet": "matic",
};

function networkLabel(slug: string): string {
  return NETWORK_LABEL[slug] ?? slug;
}

function shortAddress(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function openseaUrl(nft: Nft): string | null {
  const slug = NETWORK_SLUG_FOR_OPENSEA[nft.network];
  if (!slug) return null;
  return `https://opensea.io/assets/${slug}/${nft.contractAddress}/${nft.tokenId}`;
}

function groupKey(nft: Nft): string {
  // Group by collection (network + collection name), not by contract. Same
  // collection on different chains stays split; same name on the same
  // chain merges — multiple contracts that all share a name land in one
  // group with an address chip per contract.
  const collection = nft.collectionName?.trim() || nft.contractName.trim();
  return `${nft.network}:${collection.toLowerCase()}`;
}

// Read the persisted set of collapsed group keys. Returns an empty set
// during SSR (no window) and on any storage error — the user gets a fresh
// expanded view as the safe default.
function readCollapsedSet(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(NFT_GALLERY_COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function writeCollapsedSet(set: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NFT_GALLERY_COLLAPSED_STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // Quota exceeded or storage disabled — silently ignore. The in-memory
    // state still updates; only the persistence is lost.
  }
}

type ContractBucket = {
  contractAddress: string;
  contractImageUrl: string | null;
  items: Nft[];
};

type Group = {
  key: string;
  network: string;
  collectionName: string;
  contractName: string;
  // One bucket per underlying contract. Almost always 1, but a collection
  // minted under multiple deployments (or re-deployed after a renounce)
  // will show several — the sub-row of address chips lets the user see
  // exactly which contracts contributed which tokens.
  contracts: ContractBucket[];
};

const GROUP_COLLAPSED_SIZE = 6;

function NftImage({
  src,
  alt,
  contentType,
  className,
  fit = "cover",
  controls = false,
  showBadge = true,
}: {
  src: string | null;
  alt: string;
  contentType?: string | null;
  className?: string;
  /** `cover` (default) fills the box, cropping overflow; `contain` letterboxes. */
  fit?: "cover" | "contain";
  /** Lightbox uses `controls` so the user can play / pause / unmute.
   *  Tile previews and group logos stay without controls (still autoplay muted
   *  in the background so the user immediately sees motion). */
  controls?: boolean;
  /** Show the "Video" pill in the corner. Off for tiny contexts
   *  (group logos) where the badge crowds the artwork. */
  showBadge?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  // Two-pass media-kind resolution: trust contentType first; if missing
  // (LangGraph dev server hasn't picked up the latest normalize) and the
  // URL breaks under <img>, retry as <video>. OpenSea returns .mov for
  // video-based collection covers — same fallback applies.
  const [forceVideo, setForceVideo] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    setForceVideo(false);
  }, [src]);

  const explicitVideo = contentType?.startsWith("video/") ?? false;
  const isVideo = explicitVideo || forceVideo;

  if (!src || failed) {
    return (
      <div
        className={cn("bg-muted text-muted-foreground flex items-center justify-center", className)}
      >
        {isVideo ? <PlayCircleIcon className="size-12" /> : <ImageOffIcon className="size-12" />}
      </div>
    );
  }
  if (isVideo) {
    // Video element — `preload="metadata"` loads the first frame without
    // buffering the whole file. muted + autoPlay + loop so the gallery
    // is alive by default; controls bar only shows up in the lightbox.
    return (
      <div className={cn("bg-muted relative overflow-hidden", className)}>
        {!loaded ? (
          <div
            aria-hidden
            className="absolute inset-0 animate-pulse bg-gradient-to-r from-muted via-muted-foreground/10 to-muted"
          />
        ) : null}
        <video
          src={src}
          muted
          autoPlay
          loop
          playsInline
          preload="metadata"
          controls={controls}
          onLoadedData={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn(
            "size-full transition-opacity duration-200",
            fit === "cover" ? "object-cover" : "object-contain",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
        {!controls && showBadge ? (
          <div className="pointer-events-none absolute right-1.5 bottom-1.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
            Video
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className={cn("bg-muted relative overflow-hidden", className)}>
      {!loaded ? (
        <div
          aria-hidden
          className="absolute inset-0 animate-pulse bg-gradient-to-r from-muted via-muted-foreground/10 to-muted"
        />
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => {
          if (!contentType) setForceVideo(true);
          else setFailed(true);
        }}
        className={cn(
          "size-full transition-opacity duration-200",
          fit === "cover" ? "object-cover" : "object-contain",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

function NftTile({ nft, onOpen }: { nft: Nft; onOpen: (nft: Nft) => void }) {
  const displayName = nft.name || nft.contractName || "Untitled NFT";
  const label = networkLabel(nft.network);

  return (
    <button
      type="button"
      onClick={() => onOpen(nft)}
      data-slot="nft-gallery-tile"
      data-testid="nft-tile"
      className="border-border/40 bg-muted/30 hover:border-border hover:bg-muted/50 flex flex-col items-stretch overflow-hidden rounded-lg border text-left transition-colors"
    >
      <NftImage
        src={nft.cachedUrl || nft.thumbnailUrl}
        alt={displayName}
        contentType={nft.contentType}
        className="aspect-square w-full"
      />
      <div className="flex min-w-0 flex-col gap-0.5 p-2">
        <span className="line-clamp-1 text-xs font-medium" title={displayName}>
          {displayName}
        </span>
        <span className="text-muted-foreground mt-0.5 inline-flex items-center gap-1 text-[10px]">
          <span className="font-mono tabular-nums">#{nft.tokenId}</span>
          <span aria-hidden>·</span>
          <span>{label}</span>
        </span>
      </div>
    </button>
  );
}

function CollectionGroup({
  group,
  onOpen,
  collapsed,
  onToggleCollapsed,
}: {
  group: Group;
  onOpen: (nft: Nft) => void;
  collapsed: boolean;
  onToggleCollapsed: (key: string) => void;
}) {
  // `collapsed` is owned by the parent (persisted to localStorage). The
  // group only owns `paginated` — the per-group "show all" within an open
  // group is session-local (no need to persist across refreshes).
  const [paginated, setPaginated] = useState(false);
  const allItems = useMemo(() => group.contracts.flatMap((c) => c.items), [group]);
  const total = allItems.length;
  const visible = collapsed ? 0 : paginated ? total : Math.min(GROUP_COLLAPSED_SIZE, total);
  const hidden = total - visible;
  const headContract = group.contracts[0];

  return (
    <section className="flex flex-col gap-2" data-slot="nft-gallery-group">
      <button
        type="button"
        onClick={() => onToggleCollapsed(group.key)}
        aria-expanded={!collapsed}
        data-slot="nft-gallery-group-header"
        className="hover:bg-muted/40 flex items-center gap-2 rounded px-1 py-0.5 text-left transition-colors"
      >
        {collapsed ? (
          <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
        ) : (
          <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
        )}
        {headContract?.contractImageUrl ? (
          <NftImage
            src={headContract.contractImageUrl}
            alt={group.collectionName}
            className="border-border/40 size-8 shrink-0 rounded border"
            showBadge={false}
          />
        ) : (
          <div className="border-border/40 bg-muted flex size-7 shrink-0 items-center justify-center rounded border">
            <ImagesIcon className="text-muted-foreground size-4" />
          </div>
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-xs font-medium" title={group.collectionName}>
            {group.collectionName}
          </span>

          <span className="flex flex-wrap items-center gap-1" data-slot="nft-gallery-contracts">
            {group.contracts.map((c) => (
              <span
                key={c.contractAddress}
                className=" inline-flex items-center gap-1 rounded-full text-[10px]"
              >
                <AddressOrHash
                  value={c.contractAddress}
                  head={4}
                  tail={3}
                  className="!text-[10px]"
                  showCopyButton={false}
                  asCode={false}
                />
                <span className="text-muted-foreground tabular-nums">×{c.items.length}</span>
              </span>
            ))}
          </span>
        </span>
        <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">{total}</span>
      </button>

      {!collapsed ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="nft-grid">
            {allItems.slice(0, visible).map((nft) => (
              <NftTile key={`${nft.contractAddress}-${nft.tokenId}`} nft={nft} onOpen={onOpen} />
            ))}
          </div>
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setPaginated(true)}
              data-slot="nft-gallery-show-more"
              className="text-muted-foreground hover:text-foreground inline-flex items-center justify-center gap-1 self-center px-2 py-1 text-[10px] transition-colors"
            >
              Show {hidden} more
              <ChevronDownIcon className="size-3" />
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function NftLightbox({ nft, onClose }: { nft: Nft; onClose: () => void }) {
  const displayName = nft.name || nft.contractName || "Untitled NFT";
  const label = networkLabel(nft.network);
  const collection = nft.collectionName || nft.contractName;
  const externalHref = openseaUrl(nft);
  const [mounted, setMounted] = useState(false);

  // createPortal needs `document`. SSR would crash; the gallery card is
  // only ever mounted client-side ("use client" at top) but the first
  // render still runs through SSR with no portal target. Defer until the
  // browser paints.
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div
      data-slot="nft-gallery-lightbox"
      data-testid="nft-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={displayName}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm sm:p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-card text-card-foreground grid w-full max-w-4xl grid-cols-1 overflow-hidden rounded-2xl shadow-2xl md:grid-cols-[1.5fr_1fr]"
      >
        <NftImage
          src={nft.cachedUrl || nft.thumbnailUrl}
          alt={displayName}
          contentType={nft.contentType}
          className="aspect-square w-full"
          fit="contain"
          controls
        />

        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              {nft.collectionName ? (
                <h2 className="text-xl leading-tight font-semibold">{collection}</h2>
              ) : null}
              <p className="text-muted-foreground text-[12px] font-medium uppercase tracking-wider">
                {displayName}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-muted-foreground hover:text-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted"
            >
              <XIcon className="size-4" />
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-[11px] font-medium">
              {label}
            </span>
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] font-medium">
              {nft.tokenType}
            </span>
            {nft.balance && nft.balance !== "1" ? (
              <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums">
                Balance {nft.balance}
              </span>
            ) : null}
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border/60 pt-3 text-sm">
            <div>
              <dt className="text-muted-foreground text-[10px] font-medium uppercase tracking-wider">
                Token ID
              </dt>
              <dd className="mt-0.5 font-mono text-xs tabular-nums">#{nft.tokenId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-[10px] font-medium uppercase tracking-wider">
                Floor
              </dt>
              <dd className="mt-0.5 font-mono text-xs tabular-nums">
                {nft.floorPriceEth != null ? `${nft.floorPriceEth.toFixed(3)} ETH` : "—"}
              </dd>
            </div>
            {nft.totalSupply ? (
              <div>
                <dt className="text-muted-foreground text-[10px] font-medium uppercase tracking-wider">
                  Total supply
                </dt>
                <dd className="mt-0.5 font-mono text-xs tabular-nums">
                  {Number(nft.totalSupply).toLocaleString()}
                </dd>
              </div>
            ) : null}
          </dl>

          <div className="flex flex-col gap-1.5">
            <dt className="text-muted-foreground text-[10px] font-medium uppercase tracking-wider">
              Contract
            </dt>
            <dd>
              <AddressOrHash value={nft.contractAddress} head={10} tail={8} />
            </dd>
          </div>

          {externalHref ? (
            <a
              href={externalHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 mt-auto inline-flex items-center gap-1 self-start text-xs font-medium"
            >
              View on OpenSea
              <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const NftGalleryCard: ToolCallMessagePartComponent<Args, Result> = ({ result }) => {
  const [selected, setSelected] = useState<Nft | null>(null);
  // The collapsed Set lives here (parent) so it can be persisted; each
  // CollectionGroup only owns session-local UI state (paginated).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsedSet());
  const parsed = parse(result);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsedSet(next);
      return next;
    });
  }, []);

  const groups = useMemo<Group[]>(() => {
    if (!parsed || parsed.success === false) return [];
    // Two-level grouping: outer key = collection (network + name); inner
    // bucket = individual contract. Lets one collection that minted
    // across multiple contracts (e.g. redeploys, multi-chain mirrors) sit
    // under a single header with one chip per contract.
    const map = new Map<string, Group>();
    for (const nft of parsed.nfts) {
      const key = groupKey(nft);
      let group = map.get(key);
      if (!group) {
        group = {
          key,
          network: nft.network,
          collectionName: nft.collectionName?.trim() || nft.contractName.trim(),
          contractName: nft.contractName.trim(),
          contracts: [],
        };
        map.set(key, group);
      }
      const contractKey = nft.contractAddress.toLowerCase();
      let bucket = group.contracts.find((b) => b.contractAddress.toLowerCase() === contractKey);
      if (!bucket) {
        bucket = {
          contractAddress: nft.contractAddress,
          contractImageUrl: nft.contractImageUrl,
          items: [],
        };
        group.contracts.push(bucket);
      }
      bucket.items.push(nft);
    }
    return Array.from(map.values())
      .sort((a, b) => {
        const aTotal = a.contracts.reduce((s, c) => s + c.items.length, 0);
        const bTotal = b.contracts.reduce((s, c) => s + c.items.length, 0);
        const sizeDiff = bTotal - aTotal;
        if (sizeDiff !== 0) return sizeDiff;
        return a.collectionName.localeCompare(b.collectionName);
      })
      .map((g) => ({
        ...g,
        contracts: [...g.contracts].sort((a, b) => b.items.length - a.items.length),
      }));
  }, [parsed]);

  if (!parsed) {
    return <ToolCardSkeleton label="Fetching NFTs…" />;
  }

  if (parsed.success === false) {
    return (
      <div className="text-destructive text-xs" data-slot="nft-gallery-error">
        Couldn't fetch NFTs: {parsed.error}
      </div>
    );
  }

  const { address, nfts, totalCount } = parsed;
  const networks = Array.from(new Set(nfts.map((n) => n.network))).sort();
  const filtered = totalCount - nfts.length;

  return (
    <>
      <div
        data-slot="nft-gallery-card"
        className="border-border/60 bg-card text-card-foreground max-w-lg overflow-hidden rounded-xl border"
      >
        <header className="flex items-center gap-3 border-b border-border/40 px-4 py-3">
          <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full">
            <ImagesIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">NFT Holdings</p>
            <p className="text-muted-foreground truncate font-mono text-[11px]" title={address}>
              {shortAddress(address)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-0.5">
            <span className="text-xs font-semibold tabular-nums">
              {nfts.length}
              {filtered > 0 ? ` / ${totalCount}` : ""}
            </span>
            <span className="text-muted-foreground text-[10px]">
              {networks.length} {networks.length === 1 ? "chain" : "chains"}
            </span>
          </div>
        </header>

        {nfts.length === 0 ? (
          <p className="text-muted-foreground px-4 py-6 text-xs">
            No NFTs held at this address (after spam filter).
          </p>
        ) : (
          <div className="flex flex-col gap-4 p-3" data-testid="nft-groups">
            {groups.map((g) => (
              <CollectionGroup
                key={g.key}
                group={g}
                onOpen={setSelected}
                collapsed={collapsed.has(g.key)}
                onToggleCollapsed={toggleCollapsed}
              />
            ))}
          </div>
        )}

        <footer className="text-muted-foreground border-t border-border/40 px-4 py-1.5 text-[10px]">
          Airdrop / claim-bait filtered by name pattern.{" "}
          <a
            href="https://www.alchemy.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Alchemy
          </a>
          .
        </footer>
      </div>
      {selected ? <NftLightbox nft={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
};

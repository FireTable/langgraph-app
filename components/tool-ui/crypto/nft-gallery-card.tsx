"use client";

import { useMemo, useState } from "react";
import { ChevronDownIcon, ImagesIcon, ImageOffIcon, XIcon } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { ToolCardSkeleton } from "@/components/tool-ui/tool-card-skeleton";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";
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
  balance: string;
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

function networkLabel(slug: string): string {
  return NETWORK_LABEL[slug] ?? slug;
}

function shortAddress(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// Group key: same contract on the same chain. contractAddress alone is
// usually enough (an ERC721/ERC1155 contract lives on one chain) but
// pinning the chain makes the key collision-proof if that ever changes.
function groupKey(nft: Nft): string {
  return `${nft.network}:${nft.contractAddress.toLowerCase()}`;
}

type Group = {
  key: string;
  contractAddress: string;
  contractName: string;
  collectionName: string | null;
  contractImageUrl: string | null;
  network: string;
  items: Nft[];
};

const GROUP_COLLAPSED_SIZE = 6;

function NftTile({ nft, onOpen }: { nft: Nft; onOpen: (nft: Nft) => void }) {
  const displayName = nft.name || nft.contractName || "Untitled NFT";
  const label = networkLabel(nft.network);
  const [imgFailed, setImgFailed] = useState(false);
  const showFallback = imgFailed || !(nft.thumbnailUrl || nft.cachedUrl);

  return (
    <button
      type="button"
      onClick={() => onOpen(nft)}
      data-slot="nft-gallery-tile"
      data-testid="nft-tile"
      className="border-border/40 bg-muted/30 hover:border-border hover:bg-muted/50 flex flex-col items-stretch overflow-hidden rounded-lg border text-left transition-colors"
    >
      <div className="bg-muted relative aspect-square w-full overflow-hidden">
        {showFallback ? (
          <div className="text-muted-foreground flex size-full items-center justify-center">
            <ImageOffIcon className="size-6" />
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={nft.thumbnailUrl || nft.cachedUrl || ""}
            alt={displayName}
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="size-full object-cover"
          />
        )}
      </div>
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
}: {
  group: Group;
  onOpen: (nft: Nft) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const showCount = expanded ? group.items.length : Math.min(GROUP_COLLAPSED_SIZE, group.items.length);
  const hidden = group.items.length - showCount;
  const [headerImgFailed, setHeaderImgFailed] = useState(false);

  return (
    <section className="flex flex-col gap-2" data-slot="nft-gallery-group">
      <header className="flex items-center gap-2 px-1">
        {group.contractImageUrl && !headerImgFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={group.contractImageUrl}
            alt=""
            onError={() => setHeaderImgFailed(true)}
            className="border-border/40 size-5 shrink-0 rounded border object-cover"
          />
        ) : (
          <div className="border-border/40 bg-muted flex size-5 shrink-0 items-center justify-center rounded border">
            <ImagesIcon className="text-muted-foreground size-3" />
          </div>
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={group.collectionName || group.contractName}>
          {group.collectionName || group.contractName}
        </span>
        <span className="text-muted-foreground text-[10px] tabular-nums">
          {group.items.length}
        </span>
      </header>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="nft-grid">
        {group.items.slice(0, showCount).map((nft) => (
          <NftTile key={`${nft.tokenId}`} nft={nft} onOpen={onOpen} />
        ))}
      </div>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          data-slot="nft-gallery-show-more"
          className="text-muted-foreground hover:text-foreground inline-flex items-center justify-center gap-1 self-center px-2 py-1 text-[10px] transition-colors"
        >
          Show {hidden} more
          <ChevronDownIcon className="size-3" />
        </button>
      ) : null}
    </section>
  );
}

function NftLightbox({ nft, onClose }: { nft: Nft; onClose: () => void }) {
  const displayName = nft.name || nft.contractName || "Untitled NFT";
  const label = networkLabel(nft.network);
  const [imgFailed, setImgFailed] = useState(false);
  const showFallback = imgFailed || !(nft.cachedUrl || nft.thumbnailUrl);

  return (
    <button
      type="button"
      onClick={onClose}
      data-slot="nft-gallery-lightbox"
      data-testid="nft-lightbox"
      aria-label="Close"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
    >
      <div className="bg-card text-card-foreground flex max-h-[90vh] max-w-3xl flex-col gap-3 overflow-hidden rounded-2xl p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-medium">{displayName}</p>
            {nft.collectionName && nft.collectionName !== displayName ? (
              <p className="text-muted-foreground text-xs">{nft.collectionName}</p>
            ) : null}
            <p className="text-muted-foreground text-[10px]">
              #{nft.tokenId} · {label} · {nft.tokenType}
            </p>
          </div>
          <XIcon className="text-muted-foreground size-5 shrink-0" />
        </div>
        <div className="bg-muted relative max-h-[70vh] overflow-hidden rounded-lg">
          {showFallback ? (
            <div className="text-muted-foreground flex size-64 items-center justify-center">
              <ImageOffIcon className="size-12" />
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={nft.cachedUrl || nft.thumbnailUrl || ""}
              alt={displayName}
              onError={() => setImgFailed(true)}
              className="mx-auto max-h-[70vh] object-contain"
            />
          )}
        </div>
      </div>
    </button>
  );
}

export const NftGalleryCard: ToolCallMessagePartComponent<Args, Result> = ({ result }) => {
  const [selected, setSelected] = useState<Nft | null>(null);
  const parsed = parse(result);

  const groups = useMemo<Group[]>(() => {
    if (!parsed || parsed.success === false) return [];
    const map = new Map<string, Group>();
    for (const nft of parsed.nfts) {
      const key = groupKey(nft);
      const existing = map.get(key);
      if (existing) {
        existing.items.push(nft);
      } else {
        map.set(key, {
          key,
          contractAddress: nft.contractAddress,
          contractName: nft.contractName,
          collectionName: nft.collectionName,
          contractImageUrl: nft.contractImageUrl,
          network: nft.network,
          items: [nft],
        });
      }
    }
    // Sort: largest collections first (most noise there → user wants them up top), then alphabetical.
    return Array.from(map.values()).sort((a, b) => {
      const sizeDiff = b.items.length - a.items.length;
      if (sizeDiff !== 0) return sizeDiff;
      return (a.collectionName || a.contractName).localeCompare(b.collectionName || b.contractName);
    });
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
        className={cn(
          "border-border/60 bg-card text-card-foreground max-w-lg overflow-hidden rounded-xl border",
        )}
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
              <CollectionGroup key={g.key} group={g} onOpen={setSelected} />
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

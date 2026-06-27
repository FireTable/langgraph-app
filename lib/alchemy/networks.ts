// Static catalog of Alchemy network slugs. Slugs match Alchemy's URL
// pattern (https://<slug>.g.alchemy.com/v2/<key>). This is the source of
// truth for what the proxy accepts and what the Portfolio API can be
// queried for. The Portfolio `assets/tokens/by-address` endpoint requires
// 1-20 networks per request; we currently send the 20 mainnet entries
// that actually have real users. Obscure / specialty chains are dropped.

export type AlchemyNetworkFamily = "L1" | "L2" | "testnet";

export type NativeToken = {
  readonly symbol: string;
  readonly decimals: number;
  readonly name: string;
};

export type AlchemyNetworkEntry = {
  readonly slug: string;
  readonly name: string;
  readonly family: AlchemyNetworkFamily;
  /** EVM chain id (mainnet / L2 only — testnets carry the same id as their mainnet). */
  readonly chainId: number;
  /** Logo URL for chain-group headers in the UI. Sourced from Alchemy's
   *  emblem CDN so every chain we support has a maintained SVG. */
  readonly logo: string;
  /** Fallback metadata for the chain's native gas token. The Portfolio
   *  API always returns `tokenAddress: null` for native balances but
   *  ships `symbol/decimals/name` as `null` too — we backfill from here
   *  so a user's native ETH on Base / Arb / etc. still renders. */
  readonly nativeToken: NativeToken;
};

// Alchemy's emblem CDN. We're an Alchemy user already, so this is the
// canonical source — SVG scales to any UI size and tracks Alchemy's
// own chain list 1:1.
//
// Two slug-system mismatches to know about:
//   - polygon-mainnet is exposed at /matic-mainnet.svg (chain was
//     renamed in 2024 but the asset path didn't follow)
//   - testnet emblems are not published, so testnet entries fall back
//     to their mainnet counterpart
const ALCHEMY_EMBLEM = (iconSlug: string) =>
  `https://static.alchemyapi.io/images/emblems/${iconSlug}.svg`;

// ponytail: Alchemy never populates native-token metadata, so we ship
// our own fallback in the catalog. ETH (18) covers every L2 + the L1s
// that bridge ETH; only the truly non-ETH-native chains (Polygon, BNB,
// Avax, Gnosis xDAI, Berachain, Monad, Ronin, Celo) need their own row.
const ETH: NativeToken = { symbol: "ETH", decimals: 18, name: "Ether" };
const NATIVE: Record<string, NativeToken> = {
  "eth-mainnet": ETH,
  "polygon-mainnet": { symbol: "MATIC", decimals: 18, name: "Polygon" },
  "bnb-mainnet": { symbol: "BNB", decimals: 18, name: "BNB" },
  "avax-mainnet": { symbol: "AVAX", decimals: 18, name: "Avalanche" },
  "gnosis-mainnet": { symbol: "xDAI", decimals: 18, name: "xDai" },
  "berachain-mainnet": { symbol: "BERA", decimals: 18, name: "Berachain" },
  "monad-mainnet": { symbol: "MON", decimals: 18, name: "Monad" },
  "ronin-mainnet": { symbol: "RON", decimals: 18, name: "Ronin" },
  "arb-mainnet": ETH,
  "opt-mainnet": ETH,
  "base-mainnet": ETH,
  "linea-mainnet": ETH,
  "scroll-mainnet": ETH,
  "zksync-mainnet": ETH,
  "worldchain-mainnet": ETH,
  "unichain-mainnet": ETH,
  "blast-mainnet": ETH,
  "celo-mainnet": { symbol: "CELO", decimals: 18, name: "Celo" },
  "apechain-mainnet": ETH,
  "soneium-mainnet": ETH,
  "eth-sepolia": ETH,
  "polygon-amoy": { symbol: "MATIC", decimals: 18, name: "Polygon" },
  "arb-sepolia": ETH,
  "opt-sepolia": ETH,
  "base-sepolia": ETH,
};

const CATALOG: Record<string, AlchemyNetworkEntry> = {
  // L1
  "eth-mainnet": {
    slug: "eth-mainnet",
    name: "Ethereum",
    family: "L1",
    chainId: 1,
    logo: ALCHEMY_EMBLEM("eth-mainnet"),
    nativeToken: NATIVE["eth-mainnet"]!,
  },
  "polygon-mainnet": {
    slug: "polygon-mainnet",
    name: "Polygon",
    family: "L1",
    chainId: 137,
    logo: ALCHEMY_EMBLEM("matic-mainnet"),
    nativeToken: NATIVE["polygon-mainnet"]!,
  },
  "bnb-mainnet": {
    slug: "bnb-mainnet",
    name: "BNB Smart Chain",
    family: "L1",
    chainId: 56,
    logo: ALCHEMY_EMBLEM("bnb-mainnet"),
    nativeToken: NATIVE["bnb-mainnet"]!,
  },
  "avax-mainnet": {
    slug: "avax-mainnet",
    name: "Avalanche C-Chain",
    family: "L1",
    chainId: 43114,
    logo: ALCHEMY_EMBLEM("avax-mainnet"),
    nativeToken: NATIVE["avax-mainnet"]!,
  },
  "gnosis-mainnet": {
    slug: "gnosis-mainnet",
    name: "Gnosis",
    family: "L1",
    chainId: 100,
    logo: ALCHEMY_EMBLEM("gnosis-mainnet"),
    nativeToken: NATIVE["gnosis-mainnet"]!,
  },
  "berachain-mainnet": {
    slug: "berachain-mainnet",
    name: "Berachain",
    family: "L1",
    chainId: 80094,
    logo: ALCHEMY_EMBLEM("berachain-mainnet"),
    nativeToken: NATIVE["berachain-mainnet"]!,
  },
  "monad-mainnet": {
    slug: "monad-mainnet",
    name: "Monad",
    family: "L1",
    chainId: 143,
    logo: ALCHEMY_EMBLEM("monad-mainnet"),
    nativeToken: NATIVE["monad-mainnet"]!,
  },
  "ronin-mainnet": {
    slug: "ronin-mainnet",
    name: "Ronin",
    family: "L1",
    chainId: 2020,
    logo: ALCHEMY_EMBLEM("ronin-mainnet"),
    nativeToken: NATIVE["ronin-mainnet"]!,
  },
  // L2
  "arb-mainnet": {
    slug: "arb-mainnet",
    name: "Arbitrum One",
    family: "L2",
    chainId: 42161,
    logo: ALCHEMY_EMBLEM("arb-mainnet"),
    nativeToken: NATIVE["arb-mainnet"]!,
  },
  "opt-mainnet": {
    slug: "opt-mainnet",
    name: "Optimism",
    family: "L2",
    chainId: 10,
    logo: ALCHEMY_EMBLEM("opt-mainnet"),
    nativeToken: NATIVE["opt-mainnet"]!,
  },
  "base-mainnet": {
    slug: "base-mainnet",
    name: "Base",
    family: "L2",
    chainId: 8453,
    logo: ALCHEMY_EMBLEM("base-mainnet"),
    nativeToken: NATIVE["base-mainnet"]!,
  },
  "linea-mainnet": {
    slug: "linea-mainnet",
    name: "Linea",
    family: "L2",
    chainId: 59144,
    logo: ALCHEMY_EMBLEM("linea-mainnet"),
    nativeToken: NATIVE["linea-mainnet"]!,
  },
  "scroll-mainnet": {
    slug: "scroll-mainnet",
    name: "Scroll",
    family: "L2",
    chainId: 534352,
    logo: ALCHEMY_EMBLEM("scroll-mainnet"),
    nativeToken: NATIVE["scroll-mainnet"]!,
  },
  "zksync-mainnet": {
    slug: "zksync-mainnet",
    name: "zkSync",
    family: "L2",
    chainId: 324,
    logo: ALCHEMY_EMBLEM("zksync-mainnet"),
    nativeToken: NATIVE["zksync-mainnet"]!,
  },
  "worldchain-mainnet": {
    slug: "worldchain-mainnet",
    name: "World Chain",
    family: "L2",
    chainId: 480,
    logo: ALCHEMY_EMBLEM("worldchain-mainnet"),
    nativeToken: NATIVE["worldchain-mainnet"]!,
  },
  "unichain-mainnet": {
    slug: "unichain-mainnet",
    name: "Unichain",
    family: "L2",
    chainId: 130,
    logo: ALCHEMY_EMBLEM("unichain-mainnet"),
    nativeToken: NATIVE["unichain-mainnet"]!,
  },
  "blast-mainnet": {
    slug: "blast-mainnet",
    name: "Blast",
    family: "L2",
    chainId: 81457,
    logo: ALCHEMY_EMBLEM("blast-mainnet"),
    nativeToken: NATIVE["blast-mainnet"]!,
  },
  "celo-mainnet": {
    slug: "celo-mainnet",
    name: "Celo",
    family: "L2",
    chainId: 42220,
    logo: ALCHEMY_EMBLEM("celo-mainnet"),
    nativeToken: NATIVE["celo-mainnet"]!,
  },
  "apechain-mainnet": {
    slug: "apechain-mainnet",
    name: "ApeChain",
    family: "L2",
    chainId: 33139,
    logo: ALCHEMY_EMBLEM("apechain-mainnet"),
    nativeToken: NATIVE["apechain-mainnet"]!,
  },
  "soneium-mainnet": {
    slug: "soneium-mainnet",
    name: "Soneium",
    family: "L2",
    chainId: 1868,
    logo: ALCHEMY_EMBLEM("soneium-mainnet"),
    nativeToken: NATIVE["soneium-mainnet"]!,
  },
  // testnets — listed so the catalog stays a single source of truth, but
  // most callers (proxy allowlist, Portfolio networks list) skip them.
  // Alchemy doesn't publish testnet emblems, so we point at the mainnet
  // counterpart (chain shape is the same; only the id differs).
  "eth-sepolia": {
    slug: "eth-sepolia",
    name: "Ethereum Sepolia",
    family: "testnet",
    chainId: 11155111,
    logo: ALCHEMY_EMBLEM("eth-mainnet"),
    nativeToken: NATIVE["eth-sepolia"]!,
  },
  "polygon-amoy": {
    slug: "polygon-amoy",
    name: "Polygon Amoy",
    family: "testnet",
    chainId: 80002,
    logo: ALCHEMY_EMBLEM("matic-mainnet"),
    nativeToken: NATIVE["polygon-amoy"]!,
  },
  "arb-sepolia": {
    slug: "arb-sepolia",
    name: "Arbitrum Sepolia",
    family: "testnet",
    chainId: 421614,
    logo: ALCHEMY_EMBLEM("arb-mainnet"),
    nativeToken: NATIVE["arb-sepolia"]!,
  },
  "opt-sepolia": {
    slug: "opt-sepolia",
    name: "Optimism Sepolia",
    family: "testnet",
    chainId: 11155420,
    logo: ALCHEMY_EMBLEM("opt-mainnet"),
    nativeToken: NATIVE["opt-sepolia"]!,
  },
  "base-sepolia": {
    slug: "base-sepolia",
    name: "Base Sepolia",
    family: "testnet",
    chainId: 84532,
    logo: ALCHEMY_EMBLEM("base-mainnet"),
    nativeToken: NATIVE["base-sepolia"]!,
  },
};

export const ALCHEMY_NETWORK_CATALOG = CATALOG;

export type AlchemyNetworkSlug = keyof typeof CATALOG;

export function parseNetworkList(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export type AlchemyNetworkGroup = {
  readonly family: AlchemyNetworkFamily;
  readonly label: string;
  readonly networks: readonly AlchemyNetworkEntry[];
};

const FAMILY_ORDER: readonly AlchemyNetworkFamily[] = ["L1", "L2", "testnet"];
const FAMILY_LABEL: Record<AlchemyNetworkFamily, string> = {
  L1: "Layer 1",
  L2: "Layer 2",
  testnet: "Testnets",
};

export function groupNetworks(slugs: readonly string[]): AlchemyNetworkGroup[] {
  const buckets: Record<AlchemyNetworkFamily, AlchemyNetworkEntry[]> = {
    L1: [],
    L2: [],
    testnet: [],
  };
  for (const slug of slugs) {
    const entry = CATALOG[slug];
    if (!entry) continue;
    buckets[entry.family].push(entry);
  }
  return FAMILY_ORDER.flatMap((family) =>
    buckets[family].length === 0
      ? []
      : [{ family, label: FAMILY_LABEL[family], networks: buckets[family] }],
  );
}

// Returns the slugs the proxy will accept = the full catalog minus the
// disabled list. Alchemy doesn't expose a "list my apps" API, so the
// catalog IS the source of truth for what's available; the disabled
// list is an optional filter the user sets to turn off specific chains
// (e.g. testnets in production).
export function resolveAllowlist(disabled: readonly string[]): string[] {
  const blocked = new Set(disabled);
  return Object.keys(CATALOG).filter((slug) => !blocked.has(slug));
}

// Reverse lookup: chainId → logo URL. Built once at module load from the
// catalog so UI code can render a chain icon from just a chainId (the
// value it has on hand after fetching balances) without round-tripping
// to the slug world.
const CHAIN_ID_TO_LOGO: ReadonlyMap<number, string> = new Map(
  Object.values(CATALOG).map((e) => [e.chainId, e.logo] as const),
);

export function getNetworkLogoByChainId(chainId: number | null | undefined): string | null {
  if (chainId == null) return null;
  return CHAIN_ID_TO_LOGO.get(chainId) ?? null;
}

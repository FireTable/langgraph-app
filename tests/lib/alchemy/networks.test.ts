import { describe, it, expect } from "vitest";
import {
  ALCHEMY_NETWORK_CATALOG,
  getNetworkLogoByChainId,
  groupNetworks,
  parseNetworkList,
  resolveAllowlist,
  type AlchemyNetworkSlug,
} from "@/lib/alchemy/networks";

describe("ALCHEMY_NETWORK_CATALOG", () => {
  it("includes the major L1 networks", () => {
    expect(ALCHEMY_NETWORK_CATALOG["eth-mainnet"]).toBeTruthy();
    expect(ALCHEMY_NETWORK_CATALOG["polygon-mainnet"]).toBeTruthy();
  });

  it("includes the major L2 networks", () => {
    expect(ALCHEMY_NETWORK_CATALOG["arb-mainnet"]).toBeTruthy();
    expect(ALCHEMY_NETWORK_CATALOG["opt-mainnet"]).toBeTruthy();
    expect(ALCHEMY_NETWORK_CATALOG["base-mainnet"]).toBeTruthy();
  });

  it("includes testnets for the same families", () => {
    expect(ALCHEMY_NETWORK_CATALOG["eth-sepolia"]).toBeTruthy();
    expect(ALCHEMY_NETWORK_CATALOG["arb-sepolia"]).toBeTruthy();
    expect(ALCHEMY_NETWORK_CATALOG["base-sepolia"]).toBeTruthy();
  });

  it("every entry has a non-empty display name and a family in {L1, L2, testnet}", () => {
    for (const [slug, entry] of Object.entries(ALCHEMY_NETWORK_CATALOG)) {
      expect(entry.name.length, slug).toBeGreaterThan(0);
      expect(["L1", "L2", "testnet"], slug).toContain(entry.family);
    }
  });

  it("every entry has a logo URL pointing at Alchemy's emblem CDN", () => {
    for (const [slug, entry] of Object.entries(ALCHEMY_NETWORK_CATALOG)) {
      expect(entry.logo.length, slug).toBeGreaterThan(0);
      expect(entry.logo, slug).toMatch(
        /^https:\/\/static\.alchemyapi\.io\/images\/emblems\/.+\.svg$/,
      );
    }
  });

  it("every mainnet entry has a chainId (testnets may share with their mainnet)", () => {
    for (const [slug, entry] of Object.entries(ALCHEMY_NETWORK_CATALOG)) {
      expect(entry.chainId, slug).toBeGreaterThan(0);
    }
  });

  it("includes the 20 EVM mainnet networks with real users", () => {
    // The catalog is hand-curated: the 8 L1 + 12 L2 chains that actually
    // have meaningful user activity. Obscure / specialty chains are
    // dropped to stay under the Portfolio API's 1-20 networks per request
    // limit. A regression here means someone added or removed a chain
    // without updating the request-shape test in portfolio.test.ts.
    const mainnet = Object.values(ALCHEMY_NETWORK_CATALOG).filter((e) => e.family !== "testnet");
    expect(mainnet.length).toBe(20);
    expect(mainnet.map((e) => e.slug)).toEqual(
      expect.arrayContaining([
        // L1
        "eth-mainnet",
        "polygon-mainnet",
        "bnb-mainnet",
        "avax-mainnet",
        "gnosis-mainnet",
        "berachain-mainnet",
        "monad-mainnet",
        "ronin-mainnet",
        // L2
        "arb-mainnet",
        "opt-mainnet",
        "base-mainnet",
        "linea-mainnet",
        "scroll-mainnet",
        "zksync-mainnet",
        "worldchain-mainnet",
        "unichain-mainnet",
        "blast-mainnet",
        "celo-mainnet",
        "apechain-mainnet",
        "soneium-mainnet",
      ]),
    );
  });
});

describe("parseNetworkList", () => {
  it("parses a comma-separated string and trims whitespace", () => {
    expect(parseNetworkList("eth-mainnet, polygon-mainnet ,  arb-mainnet")).toEqual([
      "eth-mainnet",
      "polygon-mainnet",
      "arb-mainnet",
    ]);
  });

  it("drops empty entries", () => {
    expect(parseNetworkList("eth-mainnet,,polygon-mainnet,")).toEqual([
      "eth-mainnet",
      "polygon-mainnet",
    ]);
  });

  it("returns [] for empty / unset input", () => {
    expect(parseNetworkList("")).toEqual([]);
    expect(parseNetworkList("   ")).toEqual([]);
  });
});

describe("groupNetworks", () => {
  it("groups slugs into L1 / L2 / testnet buckets in that order", () => {
    const groups = groupNetworks(["eth-mainnet", "arb-mainnet", "eth-sepolia"]);
    expect(groups.map((g) => g.family)).toEqual(["L1", "L2", "testnet"]);
    expect(groups[0].networks.map((n) => n.slug)).toEqual(["eth-mainnet"]);
    expect(groups[1].networks.map((n) => n.slug)).toEqual(["arb-mainnet"]);
    expect(groups[2].networks.map((n) => n.slug)).toEqual(["eth-sepolia"]);
  });

  it("skips slugs that are not in the catalog (typos won't break the UI)", () => {
    const groups = groupNetworks(["eth-mainnet", "totally-fake-net"]);
    expect(groups.flatMap((g) => g.networks.map((n) => n.slug))).toEqual(["eth-mainnet"]);
  });

  it("omits a family bucket when no slugs in that family are present", () => {
    const groups = groupNetworks(["eth-mainnet", "polygon-mainnet"]);
    expect(groups.map((g) => g.family)).toEqual(["L1"]);
  });

  it("preserves the order from the input list within a family", () => {
    const groups = groupNetworks(["polygon-mainnet", "eth-mainnet"]);
    expect(groups[0].networks.map((n: { slug: string }) => n.slug)).toEqual([
      "polygon-mainnet",
      "eth-mainnet",
    ]);
  });
});

describe("AlchemyNetworkSlug (compile-time)", () => {
  it("is the union of catalog keys", () => {
    const slug: AlchemyNetworkSlug = "eth-mainnet";
    expect(slug).toBe("eth-mainnet");
  });
});

describe("resolveAllowlist", () => {
  it("returns every catalog slug when disabled is empty", () => {
    const allow = resolveAllowlist([]);
    expect(allow.length).toBe(Object.keys(ALCHEMY_NETWORK_CATALOG).length);
    expect(allow).toContain("eth-mainnet");
    expect(allow).toContain("base-sepolia");
  });

  it("removes the disabled slugs from the catalog", () => {
    const allow = resolveAllowlist(["eth-sepolia", "base-sepolia"]);
    expect(allow).not.toContain("eth-sepolia");
    expect(allow).not.toContain("base-sepolia");
    expect(allow).toContain("eth-mainnet");
  });

  it("ignores slugs in disabled that are not in the catalog (typos)", () => {
    const fullCount = Object.keys(ALCHEMY_NETWORK_CATALOG).length;
    const allow = resolveAllowlist(["totally-fake-net"]);
    expect(allow.length).toBe(fullCount);
  });

  it("returns [] only if the catalog is empty (impossible today, defensive)", () => {
    // Sanity: an all-disabled list is allowed — proxy will simply reject everything.
    const all = Object.keys(ALCHEMY_NETWORK_CATALOG);
    expect(resolveAllowlist(all).length).toBe(0);
  });
});

describe("getNetworkLogoByChainId", () => {
  it("returns the Alchemy emblem URL for a known chain", () => {
    expect(getNetworkLogoByChainId(1)).toBe(
      "https://static.alchemyapi.io/images/emblems/eth-mainnet.svg",
    );
    expect(getNetworkLogoByChainId(8453)).toBe(
      "https://static.alchemyapi.io/images/emblems/base-mainnet.svg",
    );
  });

  it("uses the matic-mainnet alias for polygon (chain was renamed in 2024)", () => {
    expect(getNetworkLogoByChainId(137)).toBe(
      "https://static.alchemyapi.io/images/emblems/matic-mainnet.svg",
    );
  });

  it("falls back to the mainnet emblem for a testnet chainId", () => {
    // Sepolia emblems are not published; we point at the mainnet
    // counterpart so testnet renderers don't have to special-case it.
    expect(getNetworkLogoByChainId(11155111)).toBe(
      "https://static.alchemyapi.io/images/emblems/eth-mainnet.svg",
    );
  });

  it("returns null for a chainId outside the catalog", () => {
    expect(getNetworkLogoByChainId(999999)).toBeNull();
  });

  it("returns null for null / undefined input", () => {
    expect(getNetworkLogoByChainId(null)).toBeNull();
    expect(getNetworkLogoByChainId(undefined)).toBeNull();
  });
});

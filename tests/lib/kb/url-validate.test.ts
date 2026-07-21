import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));

// ponytail: default-deny URL policy for KB ingest. Covers the obvious
// attack surface (RFC1918 / loopback / cloud metadata / file:// schemes).
// DNS-rebinding and the rebinding window between validate + fetch are
// documented in lib/kb/url-validate.ts — we can't fully pin IPs at the
// fetch layer (Jina does the request), only reject the bad ones up front.

import { validateIngestUrl } from "@/lib/kb/url-validate";

beforeEach(() => {
  mocks.lookup.mockReset();
});

describe("validateIngestUrl", () => {
  describe("scheme + parse", () => {
    it("rejects non-http(s) schemes", async () => {
      expect((await validateIngestUrl("file:///etc/passwd")).ok).toBe(false);
      expect((await validateIngestUrl("ftp://example.com/")).ok).toBe(false);
      expect((await validateIngestUrl("javascript:alert(1)")).ok).toBe(false);
      expect((await validateIngestUrl("data:text/html;base64,abc")).ok).toBe(false);
    });

    it("rejects unparseable input", async () => {
      const result = await validateIngestUrl("not a url");
      expect(result.ok).toBe(false);
    });

    it("rejects empty host", async () => {
      const result = await validateIngestUrl("http:///path");
      expect(result.ok).toBe(false);
    });
  });

  describe("host deny-list", () => {
    it("rejects localhost and *.localhost", async () => {
      expect((await validateIngestUrl("http://localhost/")).ok).toBe(false);
      expect((await validateIngestUrl("http://api.localhost/")).ok).toBe(false);
    });

    it("rejects .local and .internal", async () => {
      expect((await validateIngestUrl("http://printer.local/")).ok).toBe(false);
      expect((await validateIngestUrl("http://db.internal/")).ok).toBe(false);
    });
  });

  describe("literal IPv4 deny-list", () => {
    it.each([
      "http://10.0.0.1/",
      "http://10.255.255.255/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/",
      "http://127.0.0.1/",
      "http://127.99.99.99/",
      "http://169.254.169.254/", // AWS / GCP / Azure metadata
      "http://100.64.0.1/", // CGNAT
      "http://0.0.0.0/",
      "http://224.0.0.1/", // multicast
      "http://255.255.255.255/", // broadcast
    ])("rejects %s", async (url) => {
      const result = await validateIngestUrl(url);
      expect(result.ok).toBe(false);
    });

    it("accepts a public IPv4 literal", async () => {
      const result = await validateIngestUrl("http://8.8.8.8/");
      expect(result.ok).toBe(true);
    });
  });

  describe("literal IPv6 deny-list", () => {
    it.each([
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/",
      "http://[fe80::1]/",
      "http://[ff02::1]/",
      "http://[::ffff:10.0.0.1]/", // IPv4-mapped RFC1918
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
    ])("rejects %s", async (url) => {
      const result = await validateIngestUrl(url);
      expect(result.ok).toBe(false);
    });

    it("accepts a public IPv6 literal", async () => {
      const result = await validateIngestUrl("http://[2606:4700:4700::1111]/");
      expect(result.ok).toBe(true);
    });
  });

  describe("DNS resolution", () => {
    it("rejects when DNS lookup fails", async () => {
      mocks.lookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
      const result = await validateIngestUrl("https://no-such-host.invalid/");
      expect(result.ok).toBe(false);
    });

    it("rejects when ANY resolved address is private", async () => {
      mocks.lookup.mockResolvedValueOnce([
        { address: "1.1.1.1", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]);
      const result = await validateIngestUrl("https://split-brain.example/");
      expect(result.ok).toBe(false);
    });

    it("accepts when all resolved addresses are public", async () => {
      mocks.lookup.mockResolvedValueOnce([
        { address: "1.1.1.1", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ]);
      const result = await validateIngestUrl("https://cloudflare-dns.com/");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.addresses).toEqual(["1.1.1.1", "2606:4700:4700::1111"]);
      }
    });
  });
});

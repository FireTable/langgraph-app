import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// ponytail: KB URL ingest gets fetched via r.jina.ai/<user-url>. The
// reader service will happily follow redirects, so a hostile URL
// pointing at 169.254.169.254 (cloud metadata), 10.0.0.0/8 (RFC1918),
// or localhost can exfiltrate secrets that the Jina proxy happens to
// be able to read — and the fetched markdown is then persisted to the
// user's KB (greptile P1: URL Fetch Has No Destination Policy).
//
// Default-deny: only public http/https. Resolves the host to its IPs
// at validation time and rejects any private/loopback/link-local/CGNAT
// IPv4 or IPv6 range. The DNS result is captured for the fetch path
// so the lookup can't race between validation and request.
//
// DNS rebinding caveat: the IP we validate against is the IP at
// validation time; a hostile DNS could still return a different IP
// at fetch time. Jina does the actual fetch, so we can't pin the IP
// on the request side. The mitigation here is: deny the obvious bad
// ranges (this stops SSRF to RFC1918 / loopback), document the
// residual rebinding risk in KNOWN_HOSTS, and rely on Jina's own
// outbound policy for the rest. A future hardening step is to ship
// the bytes to Jina ourselves behind a fixed-IP egress so we can
// fully control destination policy.

type Result = { ok: true; url: URL; addresses: string[] } | { ok: false; code: string };

// ponytail: literal IPv4 ranges to deny. Anything not in this list
// is treated as public. Includes RFC1918, loopback, link-local,
// CGNAT (100.64.0.0/10), TEST-NET, multicast, reserved, and the
// cloud metadata endpoint (169.254.169.254).
function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 88 && parts[2] === 99) return true; // 6to4
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
  if (a === 224) return true; // multicast
  if (a >= 240) return true; // reserved / broadcast
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

function ipv6IsPrivate(ip: string): boolean {
  const lower = ip.toLowerCase().split("%")[0]!;
  if (lower === "::" || lower === "::1") return true; // unspecified / loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("ff")) return true; // multicast
  // ponytail: IPv4-mapped IPv6 — re-check the IPv4 part. URL.hostname
  // normalizes `[::ffff:10.0.0.1]` to `[::ffff:a00:1]` (hex form), so we
  // accept BOTH dotted (`::ffff:10.0.0.1`) and hex (`::ffff:a00:1`) by
  // decoding the last 32 bits to dotted-quad.
  const mapped = lower.match(/^::ffff:(.+)$/);
  if (mapped) {
    const tail = mapped[1]!;
    if (tail.includes(".")) return ipv4IsPrivate(tail);
    const dotted = ipv6TailHexToV4(tail);
    if (dotted) return ipv4IsPrivate(dotted);
    return true;
  }
  return false;
}

// ponytail: convert the last 32 bits of an IPv6 address (dotted-hex
// like "a00:1" or "0.255.0.1") back to dotted-quad. Returns null if
// the input can't be interpreted as 32 bits.
function ipv6TailHexToV4(tail: string): string | null {
  // hex form like `a00:1`, `ffff:ffff`, `0:ffff`
  const hexParts = tail.split(":");
  if (hexParts.length === 2) {
    const hi = parseInt(hexParts[0]!, 16);
    const lo = parseInt(hexParts[1]!, 16);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  // dotted-hex like `0:0.255.0.1` — rare, fall through.
  return null;
}

export async function validateIngestUrl(rawUrl: string): Promise<Result> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, code: "URL_INVALID" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "URL_INVALID_SCHEME" };
  }
  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, code: "URL_INVALID_HOST" };
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, code: "URL_DENIED_HOST" };
  }
  if (host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, code: "URL_DENIED_HOST" };
  }

  // ponytail: URL.hostname keeps the brackets on IPv6 literals
  // ("[::1]") — strip them before passing to isIP / the deny checks.
  const hostBare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const family = isIP(hostBare);
  if (family === 4) {
    if (ipv4IsPrivate(hostBare)) return { ok: false, code: "URL_DENIED_HOST" };
    return { ok: true, url, addresses: [hostBare] };
  }
  if (family === 6) {
    if (ipv6IsPrivate(hostBare)) return { ok: false, code: "URL_DENIED_HOST" };
    return { ok: true, url, addresses: [hostBare] };
  }

  // ponytail: DNS lookup. Captures all A + AAAA records; rejects if
  // ANY resolved address is in a private range — otherwise an attacker
  // could publish a hostname with both a public IP and a private IP,
  // and we'd hand the private one to Jina on a different lookup.
  let addresses: string[];
  try {
    const result = await lookup(hostBare, { all: true });
    addresses = result.map((r) => r.address);
  } catch {
    return { ok: false, code: "URL_DNS_LOOKUP_FAILED" };
  }
  if (addresses.length === 0) return { ok: false, code: "URL_DNS_LOOKUP_FAILED" };
  for (const addr of addresses) {
    if (isIP(addr) === 4 && ipv4IsPrivate(addr)) {
      return { ok: false, code: "URL_DENIED_HOST" };
    }
    if (isIP(addr) === 6 && ipv6IsPrivate(addr)) {
      return { ok: false, code: "URL_DENIED_HOST" };
    }
  }
  return { ok: true, url, addresses };
}

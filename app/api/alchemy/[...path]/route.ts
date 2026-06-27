import { NextResponse } from "next/server";

export const runtime = "edge";

import { parseNetworkList, resolveAllowlist } from "@/lib/alchemy/networks";

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

// ponytail: this is a thin Alchemy proxy. The browser sends
// `POST /api/alchemy/<network>` with a JSON-RPC body; we forward it
// to `https://<network>.g.alchemy.com/v2/<key>` using the server-only
// ALCHEMY_API_KEY. The key never enters the client bundle. The proxy
// rejects any slug that isn't in the static catalog (so the URL can't
// be tricked into calling arbitrary hosts); the optional
// `ALCHEMY_DISABLED_NETWORKS` denylist further restricts that.
//
// The `/api/alchemy/portfolio/<endpoint>` namespace is a separate
// branch that forwards to the global Portfolio API
// (`https://api.g.alchemy.com/data/v1/<key>/assets/<endpoint>`).
// It's not gated by the network allowlist — Portfolio API takes the
// list of networks in its body, so the allowlist wouldn't even apply.
async function handle(
  req: Request,
  method: "GET" | "POST",
  ctx: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await ctx.params;
    const first = path?.[0];

    const apiKey = process.env.ALCHEMY_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Alchemy RPC not configured" }, { status: 500 });
    }

    let upstreamUrl: string;

    if (first === "portfolio") {
      const endpoint = path.slice(1).join("/");
      if (!endpoint) {
        return NextResponse.json({ error: "portfolio endpoint is required" }, { status: 400 });
      }
      upstreamUrl = `https://api.g.alchemy.com/data/v1/${apiKey}/assets/${endpoint}`;
    } else {
      if (!first) {
        return NextResponse.json({ error: "network is required" }, { status: 400 });
      }
      const allowlist = resolveAllowlist(
        parseNetworkList(process.env.ALCHEMY_DISABLED_NETWORKS ?? ""),
      );
      if (!allowlist.includes(first)) {
        return NextResponse.json({ error: `network '${first}' is not allowed` }, { status: 400 });
      }
      upstreamUrl = `https://${first}.g.alchemy.com/v2/${apiKey}`;
    }

    const init: RequestInit = { method, signal: req.signal };
    if (method === "POST") {
      init.headers = { "Content-Type": "application/json" };
      init.body = await req.text();
    }

    const res = await fetch(upstreamUrl, init);

    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    for (const [k, v] of Object.entries(getCorsHeaders())) headers.set(k, v);

    return new NextResponse(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export const POST = (req: Request, ctx: { params: Promise<{ path: string[] }> }) =>
  handle(req, "POST", ctx);
export const GET = (req: Request, ctx: { params: Promise<{ path: string[] }> }) =>
  handle(req, "GET", ctx);
export const OPTIONS = () => new NextResponse(null, { status: 204, headers: getCorsHeaders() });

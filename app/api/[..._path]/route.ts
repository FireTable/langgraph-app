import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

import { withAuth } from "@/lib/auth/with-auth";

// ponytail: edge catch-all proxy to LANGGRAPH_API_URL. The browser
// sends `ANY /api/<rest>`; we forward to `${LANGGRAPH_API_URL}/<rest>`
// with `x-api-key: LANGCHAIN_API_KEY`. We also forward the user's
// cookie + Authorization so LangGraph can identify the calling thread.
//
// Auth: gated behind a Better Auth session via withAuth. The previous
// build accepted anonymous traffic — any website's JS could create /
// list / delete threads through this proxy. withAuth uses next/headers
// which works on edge as of Next 14.
//
// SSE: most calls are streaming runs (text/event-stream). The response
// body MUST stay a ReadableStream — buffering it to a string would
// break the stream. We do not touch res.body before returning.
function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

async function proxyRequest(req: NextRequest | Request): Promise<Response> {
  // Next.js always passes a NextRequest here, but withAuth's generic
  // typing widens it to Request — narrow at the call site so we keep
  // nextUrl access in this function.
  const nextReq = req as NextRequest;
  const path = nextReq.nextUrl.pathname.replace(/^\/?api\//, "");
  const url = new URL(nextReq.url);
  const searchParams = new URLSearchParams(url.search);
  searchParams.delete("_path");
  searchParams.delete("nxtP_path");
  const queryString = searchParams.toString() ? `?${searchParams.toString()}` : "";

  const upstreamHeaders: Record<string, string> = {
    "x-api-key": process.env.LANGCHAIN_API_KEY || "",
  };
  // Forward the user's session cookie / Authorization so LangGraph can
  // identify the calling thread. We deliberately do NOT forward every
  // header — only the two LangGraph consults.
  const cookie = nextReq.headers.get("cookie");
  if (cookie) upstreamHeaders.cookie = cookie;
  const authorization = nextReq.headers.get("authorization");
  if (authorization) upstreamHeaders.authorization = authorization;

  const options: RequestInit = {
    method: nextReq.method,
    headers: upstreamHeaders,
    signal: nextReq.signal,
  };

  if (["POST", "PUT", "PATCH"].includes(nextReq.method)) {
    options.body = await nextReq.text();
  }

  const res = await fetch(`${process.env.LANGGRAPH_API_URL}/${path}${queryString}`, options);

  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  for (const [key, value] of Object.entries(getCorsHeaders())) {
    headers.set(key, value);
  }

  return new NextResponse(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

// Next.js 16's typed-routes contract names catch-all params after the segment
// (the folder is `[..._path]`), so the generated validator expects `_path`. The
// proxy itself never reads the catch-all — it forwards the request URL — so the
// generic is purely for type alignment with the generated RouteHandlerConfig.
const authedProxy = withAuth<{ _path: string[] }>(async (req) => proxyRequest(req));

export const GET = authedProxy;
export const POST = authedProxy;
export const PUT = authedProxy;
export const PATCH = authedProxy;
export const DELETE = authedProxy;
export const OPTIONS = () =>
  new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(),
  });

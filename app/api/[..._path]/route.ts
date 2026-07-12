import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

import { withAuth } from "@/lib/auth/with-auth";
import { checkCredit } from "@/lib/credit/check";

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

// ponytail: every POST/PUT/PATCH is checked against the rolling-window
// credit cap. The check is cheap (single SUM over an indexed window) and
// avoids the path-prefix branch's surface area — the proxy's job is to
// gate token spend, not to know exactly which endpoints spend it. GET
// stays unchecked (reads only).
//
// ponytail: the proxy fabricates a tiny SSE stream that mirrors the
// shape LangGraph emits for a real run. We emit `event: messages/partial`
// carrying the new credit-blocked AI message — NOT `event: values`,
// which carries the full state and would replace (wipe) the client's
// existing message cache. `messages/partial` is append-only: the SDK
// adds the new message to whatever the user already sees in the thread,
// so prior turns stay visible alongside the CreditCard.
//
// We do NOT call the LangGraph API in this branch — `checkCredit`
// already decided the turn is blocked, so no model invocation happens
// and no recordLlmCall INSERT is queued.
function creditBlockedResponse(status: {
  used: number;
  limit: number;
  windowHours: number;
  resetAt: Date;
}): Response {
  const runId = `credit-blocked-${randomUUID()}`;
  const messageId = `msg-credit-block-${randomUUID()}`;

  const aiMessage = {
    id: messageId,
    type: "ai",
    content: "",
    tool_calls: [
      {
        id: `tc-credit-${randomUUID()}`,
        name: "show_credit_card",
        args: {
          resetAt: status.resetAt.toISOString(),
          limit: status.limit,
          used: status.used,
          windowHours: status.windowHours,
        },
        type: "tool_call",
      },
    ],
    additional_kwargs: { credit_blocked: true },
    response_metadata: {},
  };

  const events: Array<{ event: string; data: string; id: string }> = [
    { event: "metadata", id: "0", data: JSON.stringify({ run_id: runId, attempt: 1 }) },
    {
      event: "messages/partial",
      id: "1",
      data: JSON.stringify([aiMessage]),
    },
    { event: "end", id: "2", data: "{}" },
  ];

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const evt of events) {
        controller.enqueue(
          encoder.encode(`event: ${evt.event}\ndata: ${evt.data}\nid: ${evt.id}\n\n`),
        );
      }
      controller.close();
    },
  });

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      ...getCorsHeaders(),
    },
  });
}

async function proxyRequest(
  req: NextRequest | Request,
  ctx: { user: { id: string } },
): Promise<Response> {
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

  // ponytail: per-turn credit gate. Runs before any upstream fetch so a
  // blocked turn never burns a model invocation. checkCredit is a single
  // DB round-trip (role join + SUM over a window) — no need to cache at
  // this layer because LangGraph's ToolNode still records any LLM call
  // it does end up making, and the proxy only blocks once per turn.
  if (["POST", "PUT", "PATCH"].includes(nextReq.method)) {
    const credit = await checkCredit(ctx.user.id);
    if (!credit.allowed) {
      return creditBlockedResponse(credit);
    }
  }

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
    // ponytail: withMemoryRecall middleware reads userId from
    // `config.configurable.userId` on the LangGraph SDK side. The SDK
    // builds that config from the POST body, so we inject it here as a
    // pass-through — without this, userId is missing on every proxied
    // run and the model sees no memory context (FR-007). Same path for
    // the original request headers so the middleware can resolve the
    // better-auth session via cookie (US4).
    const raw = await nextReq.text();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          const config = (parsed.config ?? {}) as Record<string, unknown>;
          const configurable = (config.configurable ?? {}) as Record<string, unknown>;
          const metadata = (config.metadata ?? {}) as Record<string, unknown>;

          // append userId to the langgraph context
          configurable.userId = ctx.user.id;
          metadata.userId = ctx.user.id;

          parsed.config = config;
          if (!parsed.metadata) {
            parsed.metadata = metadata;
          }

          if (!parsed.configurable) {
            parsed.configurable = configurable;
          }

          parsed.config.configurable = configurable;
          parsed.config.metadata = metadata;

          options.body = JSON.stringify(parsed);
        } else {
          options.body = raw;
        }
      } catch {
        options.body = raw;
      }
    }
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
const authedProxy = withAuth<{ _path: string[] }>(async (req, ctx) => proxyRequest(req, ctx));

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

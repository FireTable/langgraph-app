import { vi } from "vitest";

// Hoisted before any route module imports `withAuth`. Tests opt in
// by importing { setCurrentUser } and setting a user; null = unauthenticated.

let current: { id: string; email: string } | null = null;

export function setCurrentUser(u: { id: string; email: string } | null) {
  current = u;
}

vi.mock("next/headers", () => ({
  headers: async () => ({}),
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    <TParams>(
      handler: (
        req: Request,
        ctx: { userId: string; params: TParams },
      ) => Response | Promise<Response>,
    ) =>
    async (req: Request, routeCtx?: { params: Promise<TParams> }) => {
      if (!current) {
        const { NextResponse } = await import("next/server");
        return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 });
      }
      return handler(req, {
        userId: current.id,
        // ponytail: routes without dynamic segments (e.g. /api/threads) call
        // withAuth() with no routeCtx; cast through unknown keeps the mock
        // permissive without lying about the production type.
        params: (await (routeCtx?.params ??
          Promise.resolve(undefined as unknown as TParams))) as TParams,
      });
    },
}));

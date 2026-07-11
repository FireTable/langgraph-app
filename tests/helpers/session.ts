import { vi } from "vitest";

// Hoisted before any route module imports `withAuth`. Tests opt in
// by importing { setCurrentUser } and setting a user; null = unauthenticated.

type MockUser = { id: string; email: string; roleId?: string };

let current: MockUser | null = null;

export function setCurrentUser(u: MockUser | null) {
  current = u;
}

vi.mock("next/headers", () => ({
  headers: async () => ({}),
}));

// ponytail: the production `withAuth` has two overloads —
// `withAuth(handler)` and `withAuth({ role }, handler)`. The mock below
// honors both so admin tests can pass `{ role: "admin" }` and see a
// 403 when the test user lacks the role. `current` defaults to roleId
// undefined → treated as "user" (matching lib/auth/with-auth.ts).
vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: <TParams>(optsOrHandler: unknown, maybeHandler?: unknown) => {
    const isOpts =
      typeof optsOrHandler === "object" && optsOrHandler !== null && "role" in optsOrHandler;
    const opts = (isOpts ? optsOrHandler : {}) as { role?: string | string[] };
    const handler = (isOpts ? maybeHandler : optsOrHandler) as (
      req: Request,
      ctx: { user: MockUser; params: TParams },
    ) => Response | Promise<Response>;
    return async (req: Request, routeCtx?: { params: Promise<TParams> }): Promise<Response> => {
      if (!current) {
        const { NextResponse } = await import("next/server");
        return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 });
      }
      if (opts.role) {
        const allowed = Array.isArray(opts.role) ? opts.role : [opts.role];
        const userRole = current.roleId ?? "user";
        if (!allowed.includes(userRole)) {
          const { NextResponse } = await import("next/server");
          return NextResponse.json({ code: "FORBIDDEN" }, { status: 403 });
        }
      }
      return handler(req, {
        user: current,
        // ponytail: routes without dynamic segments (e.g. /api/threads) call
        // withAuth() with no routeCtx; cast through unknown keeps the mock
        // permissive without lying about the production type.
        params: (await (routeCtx?.params ??
          Promise.resolve(undefined as unknown as TParams))) as TParams,
      });
    };
  },
}));

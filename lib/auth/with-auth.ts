import { NextResponse } from "next/server";
import { headers } from "next/headers";

import { auth } from "./config";
import { roleIdSchema } from "@/lib/credit/zod";

// ponytail: ctx.user exposes the full Better Auth user (id, email, name...).
// Handlers that only need the id do `user.id`. If we later need impersonation
// or org context, widen this shape rather than adding a second wrapper.
export type AuthContext<TParams> = {
  user: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>["user"];
  params: TParams;
};

export type AuthedHandler<TParams> = (
  req: Request,
  ctx: AuthContext<TParams>,
) => Response | Promise<Response>;

// ponytail: role gate is OR — a user with any of the listed roles passes.
// Today the only enforcement is "exact role string match"; hierarchy
// (admin implies user) is NOT implicit. If we ever ship `pro` / `vip`
// tiers that should inherit `user` privileges, switch to a precedence
// table — keeping it explicit now means no silent privilege escalation.
export type RoleGate = { role: string | string[] };

export function withAuth<TParams = unknown>(
  handler: AuthedHandler<TParams>,
): ReturnType<typeof withRoleInternal<TParams>>;
export function withAuth<TParams = unknown>(
  opts: RoleGate,
  handler: AuthedHandler<TParams>,
): ReturnType<typeof withRoleInternal<TParams>>;
export function withAuth<TParams = unknown>(
  optsOrHandler: RoleGate | AuthedHandler<TParams>,
  maybeHandler?: AuthedHandler<TParams>,
): ReturnType<typeof withRoleInternal<TParams>> {
  const isOpts =
    typeof optsOrHandler === "object" && optsOrHandler !== null && "role" in optsOrHandler;
  const opts = isOpts ? (optsOrHandler as RoleGate) : ({} as RoleGate);
  const handler = (isOpts ? maybeHandler : (optsOrHandler as AuthedHandler<TParams>))!;
  return withRoleInternal(opts, handler);
}

function withRoleInternal<TParams>(opts: RoleGate, handler: AuthedHandler<TParams>) {
  const allowed = Array.isArray(opts.role) ? opts.role : opts.role ? [opts.role] : null;

  return async (req: Request, routeCtx: { params: Promise<TParams> }): Promise<Response> => {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 });

    if (allowed) {
      // ponytail: validate at runtime — Better Auth's additionalFields typing
      // isn't tight enough to prove roleId is one of our 3 strings. Any value
      // we don't recognize falls back to 'user' (the column default) so an
      // admin route still rejects an FK-corrupt session.
      const parsed = roleIdSchema.safeParse(session.user.roleId);
      const userRole = parsed.success ? parsed.data : "user";
      if (!allowed.includes(userRole)) {
        return NextResponse.json({ code: "FORBIDDEN" }, { status: 403 });
      }
    }

    return handler(req, {
      user: session.user,
      params: await routeCtx.params,
    });
  };
}

import { NextResponse } from "next/server";
import { headers } from "next/headers";

import { auth } from "./config";

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

export function withAuth<TParams = unknown>(handler: AuthedHandler<TParams>) {
  return async (req: Request, routeCtx: { params: Promise<TParams> }): Promise<Response> => {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 });

    return handler(req, {
      user: session.user,
      params: await routeCtx.params,
    });
  };
}

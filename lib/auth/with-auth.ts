import { NextResponse } from "next/server";
import { headers } from "next/headers";

import { auth } from "./config";

// ponytail: ctx.userId is the only field handlers need today. If we later need
// the full session (e.g. impersonation, org id), widen this shape rather than
// adding a second wrapper.
export type AuthContext<TParams> = {
  userId: string;
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
      userId: session.user.id,
      params: await routeCtx.params,
    });
  };
}

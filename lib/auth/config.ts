import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import * as authSchema from "@/lib/auth/schema";
import { sendVerificationEmail } from "@/lib/email/send-verification";

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) throw new Error("BETTER_AUTH_SECRET is required");

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

// ponytail: instantiating fresh on every HMR pass keeps config edits
// (freshAge, plugins, etc.) live without a server restart. The slot type
// uses the default-generic Auth<> because two distinct generic
// instantiations of `betterAuth({...})` aren't structurally compatible in
// TS (each call widens the options type). Cast on assignment.
declare global {
  // biome-ignore lint/suspicious/noExplicitAny: see comment above.
  var __auth: any;
}

if (process.env.NODE_ENV !== "production") {
  // Drop the cached instance on every module reload so the next `??`
  // pick-up reads the new options.
  delete globalThis.__auth;
}

export const auth =
  globalThis.__auth ??
  betterAuth({
    baseURL,
    secret,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authSchema.user,
        session: authSchema.session,
        account: authSchema.account,
        verification: authSchema.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
    },
    user: {
      additionalFields: {
        // Exposed on session.user.roleId via Better Auth's additionalFields
        // plumbing; client-side reads only (`input: false` blocks signup/
        // update payloads from setting it — promotion goes through the
        // INITIAL_ADMIN_EMAIL hook in lib/auth/config.ts, not the wire).
        roleId: {
          type: "string",
          defaultValue: "user",
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // ponytail: bootstrap the first admin via env. Idempotent — only
          // the FIRST signup with a matching email is promoted; subsequent
          // signups by the same email stay `user` (Better Auth's uniqueness
          // constraint on `user.email` makes that a non-event anyway).
          // Leave INITIAL_ADMIN_EMAIL set forever; it costs nothing on
          // every other signup (one short-circuit before the UPDATE).
          after: async (created) => {
            const adminEmail = process.env.INITIAL_ADMIN_EMAIL?.toLowerCase();
            if (!adminEmail || !created.email) return;
            if (created.email.toLowerCase() !== adminEmail) return;
            if (created.roleId === "admin") return;
            await db
              .update(authSchema.user)
              .set({ roleId: "admin" })
              .where(eq(authSchema.user.id, created.id));
          },
        },
      },
      session: {
        // ponytail: block new sessions for banned users. Existing sessions
        // stay valid (the admin can revoke them explicitly via Better Auth's
        // listUserSessions / revokeUserSessions when immediate cutoff is
        // needed). Cheap because `select { banned }` is a covering query
        // and the hook runs only at signin, not on every authenticated call.
        create: {
          before: async (sessionData) => {
            const [row] = await db
              .select({ banned: authSchema.user.banned })
              .from(authSchema.user)
              .where(eq(authSchema.user.id, sessionData.userId));
            if (row?.banned) {
              throw new Error("BANNED");
            }
            return { data: sessionData };
          },
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      // ponytail: better-auth's list-sessions (and other sensitive-session
      // endpoints) reject sessions older than `freshAge` with 403
      // SESSION_NOT_FRESH. Default is 24h — fine in production where users
      // sign in daily. Dev fixtures keep a single session for days and break
      // the Security tab's "Active sessions" card, so we drop to 0 ONLY in
      // non-production environments. Session expiry (7d) still bounds
      // exposure in dev — the trade-off is "sensitive ops don't prompt for
      // re-auth" vs "dev fixtures stop breaking", and production keeps the
      // strict default.
      ...(process.env.NODE_ENV !== "production" ? { freshAge: 0 } : {}),
    },
    socialProviders: {
      github: {
        clientId: process.env.GITHUB_CLIENT_ID ?? "",
        clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
      },
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID ?? "",
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      },
    },
    emailVerification: {
      // ponytail: Better Auth 1.6.x defaults this to falsy — verified users
      // land on /login/verified without a session cookie AND without a token
      // query param (Better Auth's 302 carries just the callbackURL value).
      // Our success page then has no signal to render against and the
      // !token && !session fallback bounces them back to /login. Flip this
      // on so the verified user gets a real session and the success page is
      // reachable. Email link is the auth token either way, so this doesn't
      // widen the threat model meaningfully.
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        const result = await sendVerificationEmail({
          to: user.email,
          url: verificationRedirectUrl(url),
        });
        if (!result.ok) {
          // Translate our internal codes to the Better Auth error shape so
          // the route can return the FR-025 EMAIL_QUOTA_EXCEEDED contract.
          if (result.code === "EMAIL_QUOTA_EXCEEDED") {
            throw new Error("EMAIL_QUOTA_EXCEEDED");
          }
          throw new Error("INTERNAL");
        }
      },
    },
    trustedOrigins: [baseURL],
  });

if (process.env.NODE_ENV !== "production") globalThis.__auth = auth;

export type Session = typeof auth.$Infer.Session;

/**
 * Re-point Better Auth's verification-link `callbackURL` at our success page.
 *
 * Better Auth constructs the verification link as
 * `${baseURL}/api/auth/verify-email?token=...&callbackURL=...` (the
 * `/api/auth` prefix is Better Auth's default `basePath`; the catch-all
 * route at `app/api/auth/[...all]/route.ts` just mounts `auth.handler`
 * at that path via `toNextJsHandler` and doesn't add the prefix itself).
 * After the user clicks the link, Better Auth consumes the token at that
 * endpoint and 302s to the `callbackURL`. The default callbackURL is `/`,
 * which silently drops the user on the landing page with no feedback that
 * verification succeeded.
 *
 * We only touch the `callbackURL` query param — the verification endpoint
 * path MUST stay intact, otherwise the token is never consumed and the
 * user is never verified.
 */
export function verificationRedirectUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  u.searchParams.set("callbackURL", "/login/verified");
  return u.toString();
}

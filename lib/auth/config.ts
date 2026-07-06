import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
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
      sendVerificationEmail: async ({ user, url }) => {
        const result = await sendVerificationEmail({ to: user.email, url });
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

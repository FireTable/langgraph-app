import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db/client";
import * as authSchema from "@/lib/auth/schema";
import { sendVerificationEmail } from "@/lib/email/send-verification";

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) throw new Error("BETTER_AUTH_SECRET is required");

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

// ponytail: single instance per Node process; HMR-safe via globalThis.
// The slot type uses the default-generic Auth<> because two distinct generic
// instantiations of `betterAuth({...})` aren't structurally compatible in TS
// (each call widens the options type). Cast on assignment.
declare global {
  // biome-ignore lint/suspicious/noExplicitAny: see comment above.
  var __auth: any;
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

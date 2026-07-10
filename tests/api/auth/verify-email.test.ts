import { describe, it, expect } from "vitest";
import { verificationRedirectUrl } from "@/lib/auth/config";

// Better Auth constructs the verification link as
// `${baseURL}/api/auth/verify-email?token=...&callbackURL=...` (the
// `/api/auth` prefix is Better Auth's default `basePath`; the catch-all
// route at `app/api/auth/[...all]/route.ts` mounts the handler there).
// After the user clicks the link, Better Auth consumes the token at that
// endpoint and 302s to the callbackURL. Default callbackURL is `/` —
// silently bounces the user. We only want to swap the callbackURL value;
// the path must stay /api/auth/verify-email or the token never gets
// consumed and verification never happens.
describe("verificationRedirectUrl", () => {
  it("rewrites callbackURL=/ to /login/verified", () => {
    const out = verificationRedirectUrl(
      "http://localhost:3000/api/auth/verify-email?token=abc&callbackURL=%2F",
    );
    const u = new URL(out);
    expect(u.searchParams.get("callbackURL")).toBe("/login/verified");
  });

  it("rewrites callbackURL=/login/sign-in to /login/verified", () => {
    const out = verificationRedirectUrl(
      "http://localhost:3000/api/auth/verify-email?token=abc&callbackURL=%2Flogin%2Fsign-in",
    );
    const u = new URL(out);
    expect(u.searchParams.get("callbackURL")).toBe("/login/verified");
  });

  it("adds callbackURL when missing", () => {
    const out = verificationRedirectUrl("http://localhost:3000/api/auth/verify-email?token=abc");
    const u = new URL(out);
    expect(u.searchParams.get("callbackURL")).toBe("/login/verified");
  });

  it("preserves the verification endpoint path", () => {
    const out = verificationRedirectUrl(
      "http://localhost:3000/api/auth/verify-email?token=abc&callbackURL=%2F",
    );
    const u = new URL(out);
    // CRITICAL: replacing the path would skip verification — the token
    // would never be consumed and the user would land on a success page
    // for an unverified email.
    expect(u.pathname).toBe("/api/auth/verify-email");
  });

  it("preserves the token query param", () => {
    const out = verificationRedirectUrl(
      "http://localhost:3000/api/auth/verify-email?token=long-token-string&callbackURL=%2F",
    );
    const u = new URL(out);
    expect(u.searchParams.get("token")).toBe("long-token-string");
  });

  it("URL-encodes the new callbackURL value", () => {
    const out = verificationRedirectUrl(
      "http://localhost:3000/api/auth/verify-email?token=abc&callbackURL=%2F",
    );
    // /login/verified → %2Flogin%2Fverified in the raw query string.
    expect(out).toContain("callbackURL=%2Flogin%2Fverified");
  });
});

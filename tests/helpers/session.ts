import { vi } from "vitest";

// Hoisted before any route module imports `requireSession`. Tests opt in
// by importing { setCurrentUser } and setting a user; null = unauthenticated.

let current: { id: string; email: string } | null = null;

export function setCurrentUser(u: { id: string; email: string } | null) {
  current = u;
}

vi.mock("next/headers", () => ({
  headers: async () => ({}),
}));

vi.mock("@/lib/auth/route-helpers", () => ({
  requireSession: async () => {
    if (!current) {
      const { NextResponse } = await import("next/server");
      return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 });
    }
    return {
      user: current,
      session: { id: "s", userId: current.id, token: "t", expiresAt: new Date() },
    };
  },
}));

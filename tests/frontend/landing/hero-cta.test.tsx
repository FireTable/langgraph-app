import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { HeroCta } from "@/components/landing/hero-cta";

// HeroCta — auth-aware CTA button on the landing hero. Server-side
// reads the session in app/(marketing)/page.tsx and passes a boolean
// in; this stays a pure client component so the marketing copy
// renders identically in tests (no DB / no next/headers mocks).

describe("HeroCta", () => {
  afterEach(cleanup);

  it("renders a 'Sign in' link to /login when the visitor is signed out", () => {
    render(<HeroCta signedIn={false} />);
    const link = screen.getByRole("link", { name: /sign in/i });
    expect(link).toHaveAttribute("href", "/login");
  });

  it("renders a 'Chat now' link to /chat when the visitor is signed in", () => {
    render(<HeroCta signedIn={true} />);
    const link = screen.getByRole("link", { name: /chat now/i });
    expect(link).toHaveAttribute("href", "/chat");
  });

  it("falls back to the signed-out variant when signedIn is null (loading)", () => {
    render(<HeroCta signedIn={null} />);
    const link = screen.getByRole("link", { name: /sign in/i });
    expect(link).toHaveAttribute("href", "/login");
  });
});

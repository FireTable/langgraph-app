import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

import { VerifiedView } from "@/app/login/verified/verified-view";

// Mirrors the better-auth-ui card pattern: same Card + CardHeader +
// CardTitle + CardContent primitives, same outer `bg-muted/30` shell, same
// FieldDescription style for secondary text. The page itself is a server
// component (tested via Playwright); these tests pin the visible surface of
// the client view so a refactor that drops the success message or rewrites
// the manual link target surfaces here.

describe("VerifiedView", () => {
  afterEach(() => {
    cleanup();
    replace.mockReset();
  });

  describe("with a session (auto-signed in)", () => {
    it("renders the success heading and the chat-bound CTA", () => {
      render(<VerifiedView hasSession={true} />);

      expect(screen.getByText(/email verified/i)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /chat now/i })).toHaveAttribute("href", "/chat");
      expect(screen.getByText(/redirecting in 5s/i)).toBeInTheDocument();
    });

    it("renders the success icon", () => {
      const { container } = render(<VerifiedView hasSession={true} />);
      expect(container.querySelector("svg")).toBeInTheDocument();
    });
  });

  describe("without a session (Better Auth default — must sign in)", () => {
    it("renders the success heading and the sign-in-bound CTA", () => {
      render(<VerifiedView hasSession={false} />);

      expect(screen.getByText(/email verified/i)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /chat now/i })).toHaveAttribute("href", "/login");
    });
  });
});

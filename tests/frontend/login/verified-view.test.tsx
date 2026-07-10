import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
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
    vi.useRealTimers();
  });

  it("renders the success heading, signed-in copy, and chat-bound CTA", () => {
    render(<VerifiedView />);

    expect(screen.getByText(/email verified/i)).toBeInTheDocument();
    expect(screen.getByText(/you're signed in/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /chat now/i })).toHaveAttribute("href", "/chat");
    expect(screen.getByText(/redirecting in 5s/i)).toBeInTheDocument();
  });

  it("renders the success icon", () => {
    const { container } = render(<VerifiedView />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("redirects via router.replace to /chat at the 5-second mark", async () => {
    vi.useFakeTimers();
    render(<VerifiedView />);

    // Initial render schedules setTimeout — replace must not fire yet.
    expect(replace).not.toHaveBeenCalled();

    // Advance in 1s ticks. Each tick fires the setRemaining callback, then
    // we await act() so React re-renders and re-runs the effect with the
    // new remaining value (the effect's dep is `[remaining, router]`).
    // Without draining React between advances, all 5 timers fire against
    // stale `remaining=5` state and the final router.replace never triggers.
    //
    // 5 ticks exactly — the 5th decrements remaining to 0 and the effect's
    // `if (remaining <= 0)` branch fires router.replace. Pinning this
    // count catches a regression where the redirect drifts to 6s.
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/chat");
  });
});

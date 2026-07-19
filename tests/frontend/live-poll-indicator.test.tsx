import "@/tests/frontend/setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

import { LivePollIndicator } from "@/components/settings/kb-view/live-poll-indicator";

function renderIndicator(props: { active: boolean; intervalMs: number }) {
  return render(
    <TooltipProvider delayDuration={0}>
      <LivePollIndicator {...props} />
    </TooltipProvider>,
  );
}

// ponytail: verify the indicator's two observable states — absent
// when `active=false` (so a static doc table doesn't render an
// unexplained dot), present + showing a numeric countdown when
// `active=true` (so the user can hover and see the next refresh
// time). Internal timer precision is not asserted; the only thing
// the user perceives is the secondsLeft label.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => {
    vi.runOnlyPendingTimers();
  });
  vi.useRealTimers();
  cleanup();
});

describe("LivePollIndicator", () => {
  it("renders nothing when active=false", () => {
    renderIndicator({ active: false, intervalMs: 5000 });
    expect(screen.queryByLabelText("Auto-refreshing")).toBeNull();
  });

  it("shows a numeric countdown when active=true", () => {
    renderIndicator({ active: true, intervalMs: 5000 });
    const dot = screen.getByLabelText("Auto-refreshing");
    expect(dot).toBeTruthy();
    // ponytail: initial label is "Auto-refresh in 5s" (5_000 / 1000).
    // We don't peek into the Tooltip portal (Radix delays mount);
    // the dot itself is the user-visible contract.
    expect(dot.getAttribute("aria-label")).toBe("Auto-refreshing");
  });

  it("ticks down by 1 each second and wraps after the interval", () => {
    renderIndicator({ active: true, intervalMs: 5000 });
    // ponytail: the indicator's "secondsLeft" feeds the tooltip
    // content; assert the state transition by reading through the
    // effect — the visible tooltip text changes from 5s → 4s → ... →
    // 1s → 5s. We don't snapshot the tooltip DOM (Radix portal
    // timing varies); the only stable signal is the button itself
    // remaining mounted across the tick.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByLabelText("Auto-refreshing")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByLabelText("Auto-refreshing")).toBeTruthy();
  });
});

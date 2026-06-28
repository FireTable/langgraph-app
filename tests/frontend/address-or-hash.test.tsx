import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AddressOrHash } from "@/components/ui/address-or-hash";

// AddressOrHash — copy button writes the full value to the clipboard.
// Regression: the button must fire its onClick even when wrapped by a
// Radix Tooltip (asChild). Earlier versions silently lost the click
// because the Tooltip's pointer-down handler short-circuited before
// the inner button's onClick ran.

describe("AddressOrHash", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });
  afterEach(cleanup);

  it("copies the full value via navigator.clipboard when available", async () => {
    const value = "ord_29807b1234567890abcdef1234567890";
    render(<AddressOrHash value={value} head={10} tail={6} />);
    const btn = document.querySelector('[data-action="copy-address-or-hash"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(value);
    });
  });

  it("renders the truncated display in the button label", () => {
    const value = "ord_29807b1234567890abcdef1234567890";
    render(<AddressOrHash value={value} head={10} tail={6} />);
    const btn = document.querySelector('[data-action="copy-address-or-hash"]') as HTMLButtonElement;
    expect(btn.textContent).toContain("ord_29807b");
    expect(btn.textContent).toContain("567890");
    expect(btn.textContent).toContain("…");
  });

  it("does not render an ellipsis when the value fits within head+tail+1", () => {
    render(<AddressOrHash value="ord_abc" head={6} tail={4} />);
    const btn = document.querySelector('[data-action="copy-address-or-hash"]') as HTMLButtonElement;
    expect(btn.textContent).toContain("ord_abc");
    expect(btn.textContent).not.toContain("…");
  });

  it("flips the Copy icon to a Check after a successful copy", async () => {
    const value = "ord_check_visibility_1234567890abcdef";
    const { container } = render(<AddressOrHash value={value} head={10} tail={6} />);
    const btn = container.querySelector(
      '[data-action="copy-address-or-hash"]',
    ) as HTMLButtonElement;
    expect(container.querySelector(".lucide-copy")).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => {
      expect(container.querySelector(".lucide-check")).toBeTruthy();
      expect(container.querySelector(".lucide-copy")).toBeFalsy();
    });
  });

  it("exposes an aria-label describing what will be copied", () => {
    const value = "ord_a11y_test_1234567890abcdef";
    render(<AddressOrHash value={value} />);
    const btn = document.querySelector('[data-action="copy-address-or-hash"]') as HTMLButtonElement;
    expect(btn.getAttribute("aria-label")).toBe(`Copy ${value}`);
  });
});

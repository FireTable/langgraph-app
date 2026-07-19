import "@/tests/frontend/setup";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { DirectiveText } from "@/components/assistant-ui/directive-text";

// ponytail: DirectiveText renders the user message text with KB
// `:kb-document[…]` / `:kb-folder[…]` directives as inline chips.
// Uses `unstable_defaultDirectiveFormatter.parse` — same formatter the
// composer popover emits — so composer + bubble render stay in sync.

afterEach(cleanup);

// aUI types TextMessagePartComponent as accepting the full
// TextMessagePartProps shape (text + type + status); the unit-test only
// cares about `text`. Cast to satisfy the type without mocking the
// entire runtime.
type DirectiveTextProps = ComponentProps<typeof DirectiveText>;
const renderText = (text: string) =>
  render(<DirectiveText {...({ text } as DirectiveTextProps)} />);

describe("components/assistant-ui/DirectiveText", () => {
  it("renders plain text without directives as a single span", () => {
    renderText("hello world");
    const span = screen.getByText("hello world");
    expect(span.tagName).toBe("SPAN");
  });

  it("renders a kb-document directive as a chip with file icon (new {documentId} format)", () => {
    renderText("see :kb-document[My Doc]{documentId=d-abc-123} here");
    const chip = screen.getByText("My Doc");
    expect(chip.closest("[data-directive-type]")).toHaveAttribute(
      "data-directive-type",
      "kb-document",
    );
    expect(chip.closest("[data-directive-id]")).toHaveAttribute("data-directive-id", "d-abc-123");
  });

  it("renders a kb-folder directive as a chip with folder icon (new {folderId} format)", () => {
    renderText("see :kb-folder[Research]{folderId=f-xyz-789}");
    const chip = screen.getByText("Research");
    expect(chip.closest("[data-directive-type]")).toHaveAttribute(
      "data-directive-type",
      "kb-folder",
    );
    expect(chip.closest("[data-directive-id]")).toHaveAttribute("data-directive-id", "f-xyz-789");
  });

  it("renders multiple directives in order, interleaved with text", () => {
    const { container } = renderText(
      "first :kb-document[A]{documentId=da} middle :kb-folder[B]{folderId=fb} last",
    );
    // ponytail: text segments and chip labels are all present in DOM
    // order. We read them off the container's textContent (which
    // ignores whitespace normalization) and verify the chip DOM nodes
    // carry the right ids.
    const text = container.textContent ?? "";
    expect(text).toContain("first ");
    expect(text).toContain("A");
    expect(text).toContain(" middle ");
    expect(text).toContain("B");
    expect(text).toContain(" last");

    const chips = container.querySelectorAll("[data-directive-id]");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveAttribute("data-directive-type", "kb-document");
    expect(chips[0]).toHaveAttribute("data-directive-id", "da");
    expect(chips[1]).toHaveAttribute("data-directive-type", "kb-folder");
    expect(chips[1]).toHaveAttribute("data-directive-id", "fb");
  });

  it("falls back to label when the brace group is missing (id === label)", () => {
    renderText("see :kb-document[d-short-id]");
    const chip = screen.getByText("d-short-id");
    // ponytail: the brace group is now optional in the new format too.
    // When missing, directive-id === label (same fallback as the old
    // {id=…} form).
    expect(chip.closest("[data-directive-id]")).toHaveAttribute("data-directive-id", "d-short-id");
  });

  it("renders an unknown directive type without crashing (no icon)", () => {
    const { container } = renderText("see :kb-thing[whatever]{id=t-1}");
    const chip = screen.getByText("whatever");
    expect(chip.closest("[data-directive-type]")).toHaveAttribute(
      "data-directive-type",
      "kb-thing",
    );
    // No icon for unknown types — just a chip with the label.
    expect(chip.parentElement?.querySelector("svg")).toBeNull();
    expect(container.querySelector("[data-directive-id]")).not.toBeNull();
  });

  it("renders empty text without crashing", () => {
    const { container } = renderText("");
    expect(container.textContent).toBe("");
  });
});

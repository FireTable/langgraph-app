import "@/tests/frontend/setup";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  DIRECTIVE_CHIP_CLASS,
  renderDirectiveSegments,
} from "@/components/assistant-ui/directive-chip";

// ponytail: shared chip rendering used by DirectiveText (user message
// bubble) AND DirectiveComposerInput (composer typing area). Pinning
// its contract here means a refactor of either call site can't
// silently drift — they're guaranteed to share the same parser +
// visual style.

afterEach(cleanup);

function renderToContainer(text: string, composing = false) {
  const out = renderDirectiveSegments(text, { composing });
  const { container } = render(<>{out}</>);
  return container;
}

describe("renderDirectiveSegments", () => {
  it("renders plain text verbatim as a single span", () => {
    const c = renderToContainer("hello world");
    expect(c.textContent).toBe("hello world");
    expect(c.querySelectorAll("[data-directive-id]")).toHaveLength(0);
  });

  it("renders a kb-document directive as a chip", () => {
    const c = renderToContainer("see :kb-document[My Doc]{id=d-abc-123} here");
    const chip = c.querySelector("[data-directive-id='d-abc-123']");
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute("data-directive-type")).toBe("kb-document");
    // ponytail: chip className is DIRECTIVE_CHIP_CLASS PLUS a per-type
    // color class (getChipColorClass). assert startsWith so the test
    // survives the color-class add.
    expect(chip!.className.startsWith(DIRECTIVE_CHIP_CLASS)).toBe(true);
    expect(chip!.textContent).toContain("My Doc");
  });

  it("renders a kb-folder directive as a chip with folder icon", () => {
    const c = renderToContainer(":kb-folder[Research]{id=f-xyz-789}");
    const chip = c.querySelector("[data-directive-id='f-xyz-789']");
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute("data-directive-type")).toBe("kb-folder");
    expect(chip!.querySelector("svg")).not.toBeNull();
  });

  it("renders multiple directives interleaved with text in order", () => {
    const c = renderToContainer("a :kb-document[A]{id=da} b :kb-folder[B]{id=fb} c");
    const chips = c.querySelectorAll("[data-directive-id]");
    expect(chips).toHaveLength(2);
    expect(chips[0]!.getAttribute("data-directive-type")).toBe("kb-document");
    expect(chips[1]!.getAttribute("data-directive-type")).toBe("kb-folder");
    expect(c.textContent).toContain("a ");
    expect(c.textContent).toContain("A");
    expect(c.textContent).toContain(" b ");
    expect(c.textContent).toContain("B");
    expect(c.textContent).toContain(" c");
  });

  it("renders empty text without crashing", () => {
    const c = renderToContainer("");
    expect(c.textContent).toBe("");
    expect(c.querySelectorAll("[data-directive-id]")).toHaveLength(0);
  });

  it("composing=true skips parsing — chip-rendering stays inert during IME", () => {
    // ponytail: pinyin buffers look like "ni3hao3" and would parse as
    // nothing, but real IME strings can contain `:` / `{` / `}` that
    // would otherwise flash partial chips. Skipping the parse during
    // composition keeps the overlay aligned with the textarea.
    const c = renderToContainer(":kb-document[d]{id=di} ni3hao3", true);
    expect(c.textContent).toBe(":kb-document[d]{id=di} ni3hao3");
    expect(c.querySelectorAll("[data-directive-id]")).toHaveLength(0);
  });

  it("composing=false (default) parses directives normally", () => {
    const c = renderToContainer(":kb-document[d]{id=di} trailing");
    expect(c.querySelectorAll("[data-directive-id]")).toHaveLength(1);
    expect(c.textContent).toContain("d");
    expect(c.textContent).toContain("trailing");
  });
});

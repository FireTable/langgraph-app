import { describe, expect, it } from "vitest";

// ponytail: walkStructuredText is the unit under test. We don't
// stand up mupdf in the test runner — instead we hand-construct a
// fake StructuredText object whose walk() invokes our test's
// callbacks synchronously. Tests can drive any walker sequence
// (text-only, text + image, multi-block, etc.) without needing
// a real PDF.

import { walkStructuredText } from "@/lib/kb/text";

type FakeWalker = {
  beginTextBlock?: (bbox: number[]) => void;
  endTextBlock?: () => void;
  beginLine?: (bbox: number[]) => void;
  endLine?: () => void;
  onChar?: (c: string) => void;
  onImageBlock?: () => void;
  onVector?: () => void;
};

type FakeStructuredText = { walk: (w: FakeWalker) => void };

describe("walkStructuredText", () => {
  it("joins lines with \\n and blocks with \\n\\n, with bbox union", () => {
    const stext: FakeStructuredText = {
      walk(walker) {
        walker.beginTextBlock?.([0, 0, 200, 50]);
        walker.beginLine?.([0, 0, 200, 20]);
        for (const c of "Hello") walker.onChar?.(c);
        walker.endLine?.();
        walker.beginLine?.([0, 30, 200, 50]);
        for (const c of "World") walker.onChar?.(c);
        walker.endLine?.();
        walker.endTextBlock?.();
        walker.beginTextBlock?.([0, 60, 200, 80]);
        walker.beginLine?.([0, 60, 200, 80]);
        walker.onChar?.("!");
        walker.endLine?.();
        walker.endTextBlock?.();
      },
    };

    const result = walkStructuredText(stext as unknown as Parameters<typeof walkStructuredText>[0]);
    expect(result.text).toBe("Hello\nWorld\n\n!");
    expect(result.blocks).toEqual([
      { text: "Hello\nWorld", bbox: [0, 0, 200, 50] },
      { text: "!", bbox: [0, 60, 200, 80] },
    ]);
  });

  it("flushes a block when an image block interrupts", () => {
    const stext: FakeStructuredText = {
      walk(walker) {
        walker.beginTextBlock?.([0, 0, 100, 20]);
        walker.beginLine?.([0, 0, 100, 20]);
        walker.onChar?.("a");
        walker.onChar?.("b");
        walker.endLine?.();
        // ponytail: image block flushes the prior text block so
        // it doesn't bleed across the figure boundary
        walker.onImageBlock?.();
        walker.beginTextBlock?.([0, 30, 100, 50]);
        walker.beginLine?.([0, 30, 100, 50]);
        walker.onChar?.("c");
        walker.endLine?.();
        walker.endTextBlock?.();
      },
    };

    const result = walkStructuredText(stext as unknown as Parameters<typeof walkStructuredText>[0]);
    expect(result.blocks.length).toBe(2);
    expect(result.blocks[0].text).toBe("ab");
    expect(result.blocks[0].bbox).toEqual([0, 0, 100, 20]);
    expect(result.blocks[1].text).toBe("c");
  });

  it("returns empty blocks for empty input", () => {
    const stext: FakeStructuredText = { walk() {} };
    const result = walkStructuredText(stext as unknown as Parameters<typeof walkStructuredText>[0]);
    expect(result.blocks).toEqual([]);
    expect(result.text).toBe("");
  });
});

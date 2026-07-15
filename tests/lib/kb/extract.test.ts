import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  collectKbRefs,
  extractAllPdfParts,
  hasUnprocessedPdf,
  isFilePart,
  isKbRefPart,
  isPdfAttachment,
} from "@/lib/kb/extract";

describe("lib/kb/extract", () => {
  describe("isFilePart", () => {
    it("accepts a wire-shape file part", () => {
      expect(
        isFilePart({ type: "file", data: "https://r2/foo.pdf", mime_type: "application/pdf" }),
      ).toBe(true);
    });

    it("rejects missing type", () => {
      expect(isFilePart({ data: "x" })).toBe(false);
    });

    it("rejects non-file type", () => {
      expect(isFilePart({ type: "text", data: "x" })).toBe(false);
    });

    it("rejects missing data", () => {
      expect(isFilePart({ type: "file" })).toBe(false);
    });

    it("rejects non-string data", () => {
      expect(isFilePart({ type: "file", data: 42 })).toBe(false);
    });

    it("rejects null and primitives", () => {
      expect(isFilePart(null)).toBe(false);
      expect(isFilePart(undefined)).toBe(false);
      expect(isFilePart("file")).toBe(false);
    });
  });

  describe("isKbRefPart", () => {
    it("accepts a wire-shape kb_ref part", () => {
      expect(isKbRefPart({ type: "kb_ref", docId: "d-1" })).toBe(true);
    });

    it("accepts with optional attachmentId", () => {
      expect(isKbRefPart({ type: "kb_ref", docId: "d-1", attachmentId: "a-1" })).toBe(true);
    });

    it("rejects missing docId", () => {
      expect(isKbRefPart({ type: "kb_ref" })).toBe(false);
    });

    it("rejects non-string docId", () => {
      expect(isKbRefPart({ type: "kb_ref", docId: 42 })).toBe(false);
    });

    it("rejects non-kb_ref type", () => {
      expect(isKbRefPart({ type: "file", docId: "d-1" })).toBe(false);
    });
  });

  describe("isPdfAttachment", () => {
    it("matches application/pdf", () => {
      expect(isPdfAttachment({ type: "file", data: "x", mime_type: "application/pdf" })).toBe(true);
    });

    it("rejects other mime types", () => {
      expect(isPdfAttachment({ type: "file", data: "x", mime_type: "image/png" })).toBe(false);
    });

    it("rejects missing mime_type", () => {
      expect(isPdfAttachment({ type: "file", data: "x" })).toBe(false);
    });
  });

  describe("hasUnprocessedPdf", () => {
    const pdf = { type: "file" as const, data: "u/A", mime_type: "application/pdf" };

    it("returns true when a HumanMessage has a PDF file part", () => {
      const h = new HumanMessage({ content: [pdf], id: "h-1" });
      expect(hasUnprocessedPdf([h])).toBe(true);
    });

    it("returns false once kbAgent has replaced every PDF file part with a kb_ref", () => {
      const h = new HumanMessage({
        content: [{ type: "kb_ref", docId: "d-1" }] as never,
        id: "h-1",
      });
      expect(hasUnprocessedPdf([h])).toBe(false);
    });

    it("returns true if any HumanMessage across the array still has a PDF file part", () => {
      const processed = new HumanMessage({
        content: [{ type: "kb_ref", docId: "d-1" }] as never,
        id: "h-1",
      });
      const ai = new AIMessage("ok");
      const unprocessed = new HumanMessage({ content: [pdf], id: "h-2" });
      expect(hasUnprocessedPdf([processed, ai, unprocessed])).toBe(true);
    });

    it("returns false when a HumanMessage has only text or non-PDF files", () => {
      const h1 = new HumanMessage("plain text");
      const h2 = new HumanMessage({
        content: [{ type: "file", data: "u/img", mime_type: "image/png" }],
        id: "h-2",
      } as never);
      expect(hasUnprocessedPdf([h1, h2])).toBe(false);
    });

    it("returns false on empty input", () => {
      expect(hasUnprocessedPdf([])).toBe(false);
    });

    it("returns false when there is no HumanMessage", () => {
      const sys = new SystemMessage("x");
      const ai = new AIMessage("y");
      expect(hasUnprocessedPdf([sys, ai])).toBe(false);
    });

    it("returns true when a HumanMessage carries 2 PDFs (still unprocessed)", () => {
      const h = new HumanMessage({
        content: [
          { type: "file", data: "u/A", mime_type: "application/pdf" },
          { type: "file", data: "u/B", mime_type: "application/pdf" },
        ] as never,
        id: "h-1",
      });
      expect(hasUnprocessedPdf([h])).toBe(true);
    });
  });

  describe("extractAllPdfParts", () => {
    it("returns every PDF file part from every HumanMessage in order", () => {
      const pdfA = { type: "file" as const, data: "u/A", mime_type: "application/pdf" };
      const pdfB = { type: "file" as const, data: "u/B", mime_type: "application/pdf" };
      const h1 = new HumanMessage({
        content: [{ type: "text", text: "first" }, pdfA] as never,
        id: "h-1",
      });
      const ai = new AIMessage("ok");
      const h2 = new HumanMessage({
        content: [pdfB, { type: "text", text: "second" }] as never,
        id: "h-2",
      });
      expect(extractAllPdfParts([h1, ai, h2])).toEqual([
        { messageIndex: 0, filePart: pdfA },
        { messageIndex: 2, filePart: pdfB },
      ]);
    });

    it("returns every PDF when a single HumanMessage carries multiple", () => {
      const pdf1 = { type: "file" as const, data: "u/1", mime_type: "application/pdf" };
      const pdf2 = { type: "file" as const, data: "u/2", mime_type: "application/pdf" };
      const h = new HumanMessage({
        content: [{ type: "text", text: "compare" }, pdf1, pdf2] as never,
        id: "h-1",
      });
      const out = extractAllPdfParts([h]);
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({ messageIndex: 0, filePart: pdf1 });
      expect(out[1]).toEqual({ messageIndex: 0, filePart: pdf2 });
    });

    it("filters out non-PDF file parts (images, audio, etc.)", () => {
      const pdf = { type: "file" as const, data: "u/A", mime_type: "application/pdf" };
      const img = { type: "file" as const, data: "u/img", mime_type: "image/png" };
      const h = new HumanMessage({
        content: [pdf, img, { type: "text", text: "x" }] as never,
        id: "h-1",
      });
      expect(extractAllPdfParts([h])).toEqual([{ messageIndex: 0, filePart: pdf }]);
    });

    it("returns an empty array when no HumanMessage has a PDF", () => {
      const sys = new SystemMessage("x");
      const ai = new AIMessage("y");
      const h = new HumanMessage("plain");
      expect(extractAllPdfParts([sys, ai, h])).toEqual([]);
    });

    it("returns an empty array on empty input", () => {
      expect(extractAllPdfParts([])).toEqual([]);
    });

    it("skips HumanMessages whose content is a string", () => {
      const pdf = { type: "file" as const, data: "u/A", mime_type: "application/pdf" };
      const stringH = new HumanMessage("hi");
      const arrayH = new HumanMessage({ content: [pdf], id: "h-1" });
      expect(extractAllPdfParts([stringH, arrayH])).toEqual([{ messageIndex: 1, filePart: pdf }]);
    });
  });

  describe("collectKbRefs", () => {
    it("returns all kb_ref parts across every HumanMessage", () => {
      const refA = { type: "kb_ref" as const, docId: "d-1" };
      const refB = { type: "kb_ref" as const, docId: "d-2" };
      const h1 = new HumanMessage({ content: [refA], id: "h-1" });
      const ai = new AIMessage("ok");
      const h2 = new HumanMessage({
        content: [{ type: "text", text: "follow-up" }, refB] as never,
        id: "h-2",
      });
      expect(collectKbRefs([h1, ai, h2])).toEqual([refA, refB]);
    });

    it("preserves message order (earlier HumanMessage's kb_ref comes first)", () => {
      const refEarly = { type: "kb_ref" as const, docId: "d-early" };
      const refLate = { type: "kb_ref" as const, docId: "d-late" };
      const h1 = new HumanMessage({ content: [refEarly], id: "h-1" });
      const h2 = new HumanMessage({ content: [refLate], id: "h-2" });
      expect(collectKbRefs([h1, h2])).toEqual([refEarly, refLate]);
    });

    it("dedupes by docId — same docId in two HumanMessages appears once", () => {
      const ref = { type: "kb_ref" as const, docId: "d-shared" };
      const h1 = new HumanMessage({ content: [ref], id: "h-1" });
      const h2 = new HumanMessage({ content: [ref], id: "h-2" });
      expect(collectKbRefs([h1, h2])).toEqual([ref]);
    });

    it("returns an empty array when no HumanMessage has a kb_ref", () => {
      const sys = new SystemMessage("x");
      const ai = new AIMessage("y");
      const h = new HumanMessage("plain text");
      expect(collectKbRefs([sys, ai, h])).toEqual([]);
    });

    it("returns an empty array on empty input", () => {
      expect(collectKbRefs([])).toEqual([]);
    });

    it("skips HumanMessages whose content is a string (no parts to inspect)", () => {
      const ref = { type: "kb_ref" as const, docId: "d-1" };
      const stringH = new HumanMessage("hi");
      const arrayH = new HumanMessage({ content: [ref], id: "h-1" });
      expect(collectKbRefs([stringH, arrayH])).toEqual([ref]);
    });
  });
});

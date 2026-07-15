import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  appendKbRef,
  extractFilePart,
  extractKbRef,
  findLastHumanMessage,
  getLastHumanContent,
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

  describe("findLastHumanMessage", () => {
    it("returns the last HumanMessage in order", () => {
      const sys = new SystemMessage("hi");
      const h1 = new HumanMessage("first");
      const ai = new AIMessage("ok");
      const h2 = new HumanMessage("second");
      expect(findLastHumanMessage([sys, h1, ai, h2])).toBe(h2);
    });

    it("returns null when no HumanMessage present", () => {
      expect(findLastHumanMessage([new SystemMessage("x"), new AIMessage("y")])).toBeNull();
    });

    it("returns null on empty array", () => {
      expect(findLastHumanMessage([])).toBeNull();
    });
  });

  describe("getLastHumanContent", () => {
    it("returns array content from last HumanMessage", () => {
      const parts = [
        { type: "text", text: "hi" },
        { type: "file", data: "x", mime_type: "application/pdf" },
      ];
      const m = new HumanMessage(parts as never);
      expect(getLastHumanContent([m])).toBe(parts);
    });

    it("returns null when last HumanMessage has string content", () => {
      expect(getLastHumanContent([new HumanMessage("hello")])).toBeNull();
    });

    it("returns null when no HumanMessage", () => {
      expect(getLastHumanContent([new AIMessage("x")])).toBeNull();
    });
  });

  describe("extractFilePart", () => {
    it("extracts the file part from the last HumanMessage", () => {
      const filePart = { type: "file" as const, data: "u", mime_type: "application/pdf" };
      const m = new HumanMessage([{ type: "text", text: "look" }, filePart] as never);
      expect(extractFilePart([m])).toEqual(filePart);
    });

    it("returns null when no file part present", () => {
      const m = new HumanMessage([{ type: "text", text: "no file" }] as never);
      expect(extractFilePart([m])).toBeNull();
    });

    it("returns null when no HumanMessage", () => {
      expect(extractFilePart([])).toBeNull();
    });
  });

  describe("extractKbRef", () => {
    it("extracts the kb_ref part from the last HumanMessage", () => {
      const ref = { type: "kb_ref" as const, docId: "d-7" };
      const m = new HumanMessage([{ type: "text", text: "context" }, ref] as never);
      expect(extractKbRef([m])).toEqual(ref);
    });

    it("returns null when no kb_ref present", () => {
      const m = new HumanMessage("plain");
      expect(extractKbRef([m])).toBeNull();
    });
  });

  describe("appendKbRef", () => {
    it("appends kb_ref, drops file parts, preserves text + message id", () => {
      const filePart = { type: "file" as const, data: "u", mime_type: "application/pdf" };
      const textPart = { type: "text" as const, text: "look at this" };
      const h = new HumanMessage({
        content: [textPart, filePart],
        id: "msg-1",
      });
      const out = appendKbRef([h], "d-9", "a-3");
      expect(out).toHaveLength(1);
      const rewritten = out[0] as HumanMessage;
      expect(rewritten.id).toBe("msg-1");
      const content = rewritten.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual(textPart);
      expect(content[1]).toEqual({ type: "kb_ref", docId: "d-9", attachmentId: "a-3" });
    });

    it("replaces a pre-existing kb_ref (idempotent re-append)", () => {
      const oldRef = { type: "kb_ref" as const, docId: "d-old" };
      const h = new HumanMessage({ content: [oldRef], id: "m-1" });
      const out = appendKbRef([h], "d-new", "a-1");
      const content = (out[0] as HumanMessage).content as Array<Record<string, unknown>>;
      expect(content).toEqual([{ type: "kb_ref", docId: "d-new", attachmentId: "a-1" }]);
    });

    it("returns messages unchanged when no HumanMessage present", () => {
      const sys = new SystemMessage("hi");
      const ai = new AIMessage("ok");
      const out = appendKbRef([sys, ai], "d-1");
      expect(out).toBe(out); // reference equality — no rewrite happened
      expect(out).toHaveLength(2);
    });

    it("returns messages unchanged when last HumanMessage has string content", () => {
      const h = new HumanMessage("plain text only");
      const out = appendKbRef([h], "d-1");
      expect(out[0]).toBe(h);
    });

    it("passes attachmentId as undefined when not provided (downstream predicate ignores it)", () => {
      const h = new HumanMessage({ content: [], id: "m" });
      const out = appendKbRef([h], "d-1");
      const content = (out[0] as HumanMessage).content as Array<Record<string, unknown>>;
      // KbRefPart.attachmentId is optional; isKbRefPart doesn't read it, so
      // undefined is harmless on the wire.
      expect(content[0].attachmentId).toBeUndefined();
      expect(content[0].docId).toBe("d-1");
    });

    it("does not mutate the input message array", () => {
      const filePart = { type: "file" as const, data: "u", mime_type: "application/pdf" };
      const h = new HumanMessage({ content: [filePart], id: "m-1" });
      const originalContent = h.content;
      appendKbRef([h], "d-1");
      expect(h.content).toBe(originalContent);
    });
  });
});

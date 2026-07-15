import { HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ponytail: resolve.ts is a thin wrapper over getKbDocForResolve. Mock the
// cache layer so each test controls the doc status the resolver sees.
const { getKbDocForResolve } = vi.hoisted(() => ({
  getKbDocForResolve: vi.fn(),
}));

vi.mock("@/lib/kb/cache", () => ({ getKbDocForResolve }));

import { resolveKbRef, resolveKbRefs } from "@/lib/kb/resolve";

const USER = "user-1";
const DOC = "doc-1";

function docWithStatus(
  status: "pending" | "parsing" | "success" | "failed",
  errorMessage: string | null = null,
) {
  return {
    id: DOC,
    userId: USER,
    folderId: "f-1",
    attachmentId: "a-1",
    title: "resume.pdf",
    contentType: "application/pdf",
    contentHash: "h",
    status,
    errorMessage,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function humanWithKbRef(docId = DOC, extraParts: Array<Record<string, unknown>> = []) {
  return [
    new HumanMessage({
      content: [
        { type: "text", text: "context" },
        { type: "kb_ref", docId },
        ...extraParts,
      ] as never,
      id: "m-1",
    }),
  ];
}

beforeEach(() => {
  getKbDocForResolve.mockReset();
});

describe("lib/kb/resolve", () => {
  describe("resolveKbRef", () => {
    it("returns null when the cache has no entry", async () => {
      getKbDocForResolve.mockResolvedValueOnce(null);
      expect(await resolveKbRef(DOC, USER)).toBeNull();
    });

    it("returns concatenated chunks for a success doc", async () => {
      getKbDocForResolve.mockResolvedValueOnce({
        doc: docWithStatus("success"),
        chunks: [
          { content: "alpha", ordinal: 0 } as never,
          { content: "beta", ordinal: 1 } as never,
        ],
      });
      expect(await resolveKbRef(DOC, USER)).toBe("alpha\n\nbeta");
    });

    it("returns [Processing...] for parsing status", async () => {
      getKbDocForResolve.mockResolvedValueOnce({ doc: docWithStatus("parsing"), chunks: [] });
      expect(await resolveKbRef(DOC, USER)).toBe("[Processing...]");
    });

    it("returns [Pending] for pending status", async () => {
      getKbDocForResolve.mockResolvedValueOnce({ doc: docWithStatus("pending"), chunks: [] });
      expect(await resolveKbRef(DOC, USER)).toBe("[Pending]");
    });

    it("returns [Failed: <error>] for failed status with error message", async () => {
      getKbDocForResolve.mockResolvedValueOnce({
        doc: docWithStatus("failed", "OCR timed out"),
        chunks: [],
      });
      expect(await resolveKbRef(DOC, USER)).toBe("[Failed: OCR timed out]");
    });

    it("returns [Failed: unknown error] for failed status with null error", async () => {
      getKbDocForResolve.mockResolvedValueOnce({
        doc: docWithStatus("failed", null),
        chunks: [],
      });
      expect(await resolveKbRef(DOC, USER)).toBe("[Failed: unknown error]");
    });
  });

  describe("resolveKbRefs", () => {
    it("returns messages unchanged when no userId", async () => {
      const msgs = humanWithKbRef();
      const out = await resolveKbRefs(msgs, "");
      expect(out).toBe(msgs);
      expect(getKbDocForResolve).not.toHaveBeenCalled();
    });

    it("returns messages unchanged when no kb_ref present", async () => {
      const msgs = [new HumanMessage({ content: [{ type: "text", text: "plain" }], id: "m" })];
      const out = await resolveKbRefs(msgs, USER);
      expect(out).toBe(msgs);
      expect(getKbDocForResolve).not.toHaveBeenCalled();
    });

    it("replaces the kb_ref part with resolved text", async () => {
      getKbDocForResolve.mockResolvedValueOnce({
        doc: docWithStatus("success"),
        chunks: [{ content: "resolved text", ordinal: 0 } as never],
      });
      const msgs = humanWithKbRef();
      const out = await resolveKbRefs(msgs, USER);
      const content = (out[0] as HumanMessage).content as Array<Record<string, unknown>>;
      // text part kept, kb_ref swapped for text part.
      expect(content).toEqual([
        { type: "text", text: "context" },
        { type: "text", text: "resolved text" },
      ]);
    });

    it("preserves the message id through the rewrite", async () => {
      getKbDocForResolve.mockResolvedValueOnce({
        doc: docWithStatus("success"),
        chunks: [{ content: "x", ordinal: 0 } as never],
      });
      const msgs = humanWithKbRef();
      const out = await resolveKbRefs(msgs, USER);
      expect((out[0] as HumanMessage).id).toBe("m-1");
    });

    it("strips the kb_ref entirely when the doc is not found", async () => {
      getKbDocForResolve.mockResolvedValueOnce(null);
      const msgs = humanWithKbRef();
      const out = await resolveKbRefs(msgs, USER);
      const content = (out[0] as HumanMessage).content as Array<Record<string, unknown>>;
      expect(content).toEqual([{ type: "text", text: "context" }]);
    });

    it("uses the placeholder text when status is parsing", async () => {
      getKbDocForResolve.mockResolvedValueOnce({ doc: docWithStatus("parsing"), chunks: [] });
      const msgs = humanWithKbRef();
      const out = await resolveKbRefs(msgs, USER);
      const content = (out[0] as HumanMessage).content as Array<Record<string, unknown>>;
      expect(content[1]).toEqual({ type: "text", text: "[Processing...]" });
    });

    it("uses the placeholder text when status is pending", async () => {
      getKbDocForResolve.mockResolvedValueOnce({ doc: docWithStatus("pending"), chunks: [] });
      const msgs = humanWithKbRef();
      const out = await resolveKbRefs(msgs, USER);
      const content = (out[0] as HumanMessage).content as Array<Record<string, unknown>>;
      expect(content[1]).toEqual({ type: "text", text: "[Pending]" });
    });

    it("uses [Failed: <msg>] when status is failed", async () => {
      getKbDocForResolve.mockResolvedValueOnce({
        doc: docWithStatus("failed", "OCR error"),
        chunks: [],
      });
      const msgs = humanWithKbRef();
      const out = await resolveKbRefs(msgs, USER);
      const content = (out[0] as HumanMessage).content as Array<Record<string, unknown>>;
      expect(content[1]).toEqual({ type: "text", text: "[Failed: OCR error]" });
    });

    it("returns messages unchanged when the kb_ref docId doesn't match any part", async () => {
      // Sanity guard: extractKbRef finds the first kb_ref; if the resolver
      // couldn't, it returns the array reference unchanged. Build a case
      // where extractKbRef fails (no human message at all).
      const out = await resolveKbRefs([], USER);
      expect(out).toEqual([]);
      expect(getKbDocForResolve).not.toHaveBeenCalled();
    });

    it("scopes by userId — getKbDocForResolve receives the caller's userId", async () => {
      getKbDocForResolve.mockResolvedValueOnce({
        doc: docWithStatus("success"),
        chunks: [{ content: "x", ordinal: 0 } as never],
      });
      await resolveKbRefs(humanWithKbRef(), "specific-user");
      expect(getKbDocForResolve).toHaveBeenCalledWith("specific-user", DOC);
    });
  });
});

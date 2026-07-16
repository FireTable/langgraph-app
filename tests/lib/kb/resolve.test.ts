import { HumanMessage, SystemMessage } from "@langchain/core/messages";
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

    // ponytail: data-integrity guard. kbAgent writes chunks BEFORE
    // flipping status=success, so a doc row with status=success and no
    // chunks shouldn't happen via the agent — but a manual SQL edit,
    // a backfill script, or a future reprocess path could leave one
    // here. Returning an empty string would silently drop the doc
    // context; [Processing...] is the closest existing placeholder
    // ("the doc is being prepared, ask again in a moment") which
    // matches the on-the-wire intent for the model.
    it("returns [Processing...] when status is success but chunks are empty and pages is null", async () => {
      getKbDocForResolve.mockResolvedValueOnce({
        doc: docWithStatus("success"),
        chunks: [],
      });
      expect(await resolveKbRef(DOC, USER)).toBe("[Processing...]");
    });

    it("falls back to doc.pages when success but chunks are empty", async () => {
      getKbDocForResolve.mockResolvedValueOnce({
        doc: {
          ...docWithStatus("success"),
          pages: [{ pageIndex: 0, imageUrl: "img", markdown: "persisted page text" }],
        },
        chunks: [],
      });
      expect(await resolveKbRef(DOC, USER)).toBe("persisted page text");
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

    it("returns messages unchanged when there are no HumanMessages to inspect", async () => {
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

    // ponytail: state.messages is append-only (LangGraph addMessages reducer),
    // so a kb_ref from an earlier turn can sit in an earlier HumanMessage
    // while the current turn's HumanMessage has plain text. The old
    // findLastHumanIndex pass missed those — fix covers all HumanMessages.
    it("resolves a kb_ref sitting in an earlier HumanMessage", async () => {
      getKbDocForResolve.mockResolvedValueOnce({
        doc: docWithStatus("success"),
        chunks: [{ content: "earlier doc text", ordinal: 0 } as never],
      });
      const earlier = new HumanMessage({
        content: [{ type: "kb_ref", docId: DOC }] as never,
        id: "h-earlier",
      });
      const ai = new HumanMessage({ content: "ai reply" } as never);
      const current = new HumanMessage({ content: "follow-up question" } as never);
      const out = await resolveKbRefs([earlier, ai, current], USER);
      const earlierOut = out[0] as HumanMessage;
      const currentOut = out[2] as HumanMessage;
      expect((earlierOut.content as Array<Record<string, unknown>>)[0]).toEqual({
        type: "text",
        text: "earlier doc text",
      });
      expect(earlierOut.id).toBe("h-earlier");
      expect(currentOut).toBe(current);
      expect(getKbDocForResolve).toHaveBeenCalledTimes(1);
    });

    it("resolves kb_refs in EVERY HumanMessage that has one", async () => {
      getKbDocForResolve
        .mockResolvedValueOnce({
          doc: docWithStatus("success"),
          chunks: [{ content: "doc A text", ordinal: 0 } as never],
        })
        .mockResolvedValueOnce({
          doc: { ...docWithStatus("success"), id: "doc-2" },
          chunks: [{ content: "doc B text", ordinal: 0 } as never],
        });
      const h1 = new HumanMessage({
        content: [{ type: "kb_ref", docId: "doc-1" }] as never,
        id: "h-1",
      });
      const h2 = new HumanMessage({
        content: [{ type: "kb_ref", docId: "doc-2" }] as never,
        id: "h-2",
      });
      const out = await resolveKbRefs([h1, h2], USER);
      expect((out[0] as HumanMessage).content as Array<Record<string, unknown>>).toEqual([
        { type: "text", text: "doc A text" },
      ]);
      expect((out[1] as HumanMessage).content as Array<Record<string, unknown>>).toEqual([
        { type: "text", text: "doc B text" },
      ]);
      expect(getKbDocForResolve).toHaveBeenCalledTimes(2);
    });

    it("dedupes parallel resolves — same docId across two HumanMessages hits the cache once", async () => {
      getKbDocForResolve.mockResolvedValueOnce({
        doc: docWithStatus("success"),
        chunks: [{ content: "shared", ordinal: 0 } as never],
      });
      const h1 = new HumanMessage({
        content: [{ type: "kb_ref", docId: DOC }] as never,
        id: "h-1",
      });
      const h2 = new HumanMessage({
        content: [{ type: "kb_ref", docId: DOC }] as never,
        id: "h-2",
      });
      const out = await resolveKbRefs([h1, h2], USER);
      expect(getKbDocForResolve).toHaveBeenCalledTimes(1);
      expect((out[0] as HumanMessage).content).toEqual([{ type: "text", text: "shared" }]);
      expect((out[1] as HumanMessage).content).toEqual([{ type: "text", text: "shared" }]);
    });

    it("strips a kb_ref from an earlier HumanMessage when the doc is not found", async () => {
      getKbDocForResolve.mockResolvedValueOnce(null);
      const earlier = new HumanMessage({
        content: [
          { type: "text", text: "context" },
          { type: "kb_ref", docId: DOC },
        ] as never,
        id: "h-earlier",
      });
      const current = new HumanMessage({ content: "follow-up" } as never);
      const out = await resolveKbRefs([earlier, current], USER);
      expect((out[0] as HumanMessage).content).toEqual([{ type: "text", text: "context" }]);
      expect(out[1]).toBe(current);
    });

    it("resolves multiple kb_ref parts within a single HumanMessage", async () => {
      getKbDocForResolve
        .mockResolvedValueOnce({
          doc: { ...docWithStatus("success"), id: "doc-1" },
          chunks: [{ content: "alpha", ordinal: 0 } as never],
        })
        .mockResolvedValueOnce({
          doc: { ...docWithStatus("success"), id: "doc-2" },
          chunks: [{ content: "beta", ordinal: 0 } as never],
        });
      const h = new HumanMessage({
        content: [
          { type: "text", text: "compare" },
          { type: "kb_ref", docId: "doc-1" },
          { type: "kb_ref", docId: "doc-2" },
        ] as never,
        id: "h-1",
      });
      const out = await resolveKbRefs([h], USER);
      expect((out[0] as HumanMessage).content).toEqual([
        { type: "text", text: "compare" },
        { type: "text", text: "alpha" },
        { type: "text", text: "beta" },
      ]);
    });

    it("passes non-Human messages through untouched", async () => {
      getKbDocForResolve.mockResolvedValueOnce({
        doc: docWithStatus("success"),
        chunks: [{ content: "x", ordinal: 0 } as never],
      });
      const sys = new SystemMessage("sys prompt");
      const ai = { role: "assistant", content: "ai reply" } as never;
      const h = new HumanMessage({
        content: [{ type: "kb_ref", docId: DOC }] as never,
        id: "h-1",
      });
      const out = await resolveKbRefs([sys, ai, h], USER);
      expect(out[0]).toBe(sys);
      expect(out[1]).toBe(ai);
      expect((out[2] as HumanMessage).content).toEqual([{ type: "text", text: "x" }]);
    });
  });
});

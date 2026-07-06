import { describe, expect, it } from "vitest";

import {
  MemoryPatchSchema,
  SaveMemoryInputSchema,
  MemoryResponseSchema,
  ThreadsResponseSchema,
  SummaryEntrySchema,
  ProfileDeleteResponseSchema,
  ThreadsDeleteResponseSchema,
} from "@/lib/memory/validators";

describe("lib/memory/validators", () => {
  describe("MemoryPatchSchema", () => {
    it("accepts a single add op with valid path + value", () => {
      const r = MemoryPatchSchema.safeParse({
        op: "add",
        path: "/role",
        value: "frontend",
      });
      expect(r.success).toBe(true);
    });

    it("accepts a replace op", () => {
      const r = MemoryPatchSchema.safeParse({
        op: "replace",
        path: "/role",
        value: "backend",
      });
      expect(r.success).toBe(true);
    });

    it("accepts a remove op with no value", () => {
      const r = MemoryPatchSchema.safeParse({ op: "remove", path: "/role" });
      expect(r.success).toBe(true);
    });

    it("rejects move / copy / test ops (RFC 6902 not supported by save_memory)", () => {
      for (const op of ["move", "copy", "test"]) {
        const r = MemoryPatchSchema.safeParse({
          op,
          from: "/a",
          path: "/b",
        });
        expect(r.success, op).toBe(false);
      }
    });

    it("rejects paths containing `..` (path traversal in RFC 6901)", () => {
      const r = MemoryPatchSchema.safeParse({
        op: "remove",
        path: "/role/../wallet",
      });
      expect(r.success).toBe(false);
    });

    it("rejects array indices (must be k-v profile; array writes disallowed)", () => {
      const r = MemoryPatchSchema.safeParse({
        op: "add",
        path: "/0",
        value: "x",
      });
      expect(r.success).toBe(false);
    });

    it("requires `value` on add / replace", () => {
      for (const op of ["add", "replace"]) {
        const r = MemoryPatchSchema.safeParse({ op, path: "/role" });
        expect(r.success, op).toBe(false);
      }
    });

    it("requires path to start with `/`", () => {
      const r = MemoryPatchSchema.safeParse({
        op: "add",
        path: "role",
        value: "x",
      });
      expect(r.success).toBe(false);
    });
  });

  describe("SaveMemoryInputSchema", () => {
    it("accepts an empty patches array for no-op writes", () => {
      // Empty arrays are valid by Zod .min(0); save_memory itself treats
      // empty input as a no-op success. Validators stay schema-only.
      const r = SaveMemoryInputSchema.safeParse({ patches: [] });
      expect(r.success).toBe(true);
    });

    it("accepts 1..50 patches", () => {
      const ok = SaveMemoryInputSchema.safeParse({
        patches: [{ op: "add", path: "/a", value: 1 }],
      });
      expect(ok.success).toBe(true);
      const tooMany = SaveMemoryInputSchema.safeParse({
        patches: Array.from({ length: 51 }, (_, i) => ({
          op: "add" as const,
          path: `/k${i}`,
          value: i,
        })),
      });
      expect(tooMany.success).toBe(false);
    });
  });

  describe("MemoryResponseSchema", () => {
    it("accepts a full payload (memory + threads)", () => {
      const r = MemoryResponseSchema.safeParse({
        memory: { role: "frontend", name: "Yongzhuo" },
        threads: [
          {
            key: "t1:1",
            value: {
              threadId: "t1",
              sequence: 1,
              startMessageIndex: 0,
              endMessageIndex: 6,
              messageCount: 7,
              messageIds: ["m0", "m1", "m2", "m3", "m4", "m5", "m6"],
              summary: { entries: [{ question: "...", answer: "...", refs: ["#1-#4"] }] },
              triggerReason: "turn_based",
              tokenCountBefore: 0,
              tokenCountAfter: 0,
              createdAt: "2026-07-02T00:00:00.000Z",
            },
            // ponytail: threadTitle rides on each summary entry —
            // renameThreadAgent populates the row on the first turn;
            // null is the documented fallback for unrenamed threads.
            threadTitle: "Weather chat",
          },
        ],
      });
      expect(r.success).toBe(true);
    });

    it("accepts a thread entry with threadTitle=null (rename path not run)", () => {
      const r = MemoryResponseSchema.safeParse({
        memory: {},
        threads: [
          {
            key: "t1:1",
            value: {
              threadId: "t1",
              sequence: 1,
              startMessageIndex: 0,
              endMessageIndex: 0,
              messageCount: 1,
              messageIds: ["m0"],
              summary: { entries: [{ question: "...", answer: "...", refs: ["#1"] }] },
              triggerReason: "turn_based",
              tokenCountBefore: 0,
              tokenCountAfter: 0,
              createdAt: "2026-07-02T00:00:00.000Z",
            },
            threadTitle: null,
          },
        ],
      });
      expect(r.success).toBe(true);
    });

    it("accepts an empty memory + no threads", () => {
      const r = MemoryResponseSchema.safeParse({
        memory: {},
        threads: [],
      });
      expect(r.success).toBe(true);
    });
  });

  describe("ThreadsResponseSchema", () => {
    it("accepts grouped thread summaries", () => {
      const r = ThreadsResponseSchema.safeParse({
        threads: [
          {
            threadId: "t1",
            summaries: [
              {
                threadId: "t1",
                sequence: 1,
                startMessageIndex: 0,
                endMessageIndex: 6,
                messageCount: 7,
                messageIds: ["m0", "m1", "m2", "m3", "m4", "m5", "m6"],
                summary: { entries: [{ question: "...", answer: "...", refs: ["#1-#7"] }] },
                triggerReason: "turn_based",
                tokenCountBefore: 0,
                tokenCountAfter: 0,
                createdAt: "2026-07-02T00:00:00.000Z",
              },
            ],
          },
        ],
      });
      expect(r.success).toBe(true);
    });
  });

  describe("SummaryEntrySchema", () => {
    it("enforces messageCount = endMessageIndex - startMessageIndex + 1 (closed interval)", () => {
      const r = SummaryEntrySchema.safeParse({
        threadId: "t1",
        sequence: 1,
        startMessageIndex: 0,
        endMessageIndex: 6,
        messageCount: 7,
        messageIds: ["m0", "m1", "m2", "m3", "m4", "m5", "m6"],
        summary: { entries: [{ question: "...", answer: "...", refs: ["#1-#4"] }] },
        triggerReason: "turn_based",
        tokenCountBefore: 0,
        tokenCountAfter: 0,
        createdAt: "2026-07-02T00:00:00.000Z",
      });
      expect(r.success).toBe(true);
    });

    it("rejects mismatched messageCount", () => {
      const r = SummaryEntrySchema.safeParse({
        threadId: "t1",
        sequence: 1,
        startMessageIndex: 0,
        endMessageIndex: 6,
        messageCount: 5,
        messageIds: ["m0"],
        summary: { entries: [{ question: "...", answer: "...", refs: ["#1-#4"] }] },
        createdAt: "2026-07-02T00:00:00.000Z",
      });
      expect(r.success).toBe(false);
    });

    it("requires summary (no name/description in the new schema)", () => {
      const r = SummaryEntrySchema.safeParse({
        threadId: "t1",
        sequence: 1,
        startMessageIndex: 0,
        endMessageIndex: 0,
        messageCount: 1,
        messageIds: ["m0"],
        // summary missing
        createdAt: "2026-07-02T00:00:00.000Z",
      });
      expect(r.success).toBe(false);
    });

    it("requires non-empty messageIds array (one per covered human-only turn)", () => {
      const r = SummaryEntrySchema.safeParse({
        threadId: "t1",
        sequence: 1,
        startMessageIndex: 0,
        endMessageIndex: 0,
        messageCount: 1,
        messageIds: [],
        summary: { entries: [{ question: "...", answer: "...", refs: ["#1"] }] },
        createdAt: "2026-07-02T00:00:00.000Z",
      });
      expect(r.success).toBe(false);
    });

    it("requires messageIds.length === messageCount", () => {
      const r = SummaryEntrySchema.safeParse({
        threadId: "t1",
        sequence: 1,
        startMessageIndex: 0,
        endMessageIndex: 2,
        messageCount: 3,
        messageIds: ["m0", "m1"], // one short
        summary: { entries: [{ question: "...", answer: "...", refs: ["#1-#3"] }] },
        createdAt: "2026-07-02T00:00:00.000Z",
      });
      expect(r.success).toBe(false);
    });
  });

  describe("Delete responses", () => {
    it("ProfileDeleteResponseSchema requires ok + deletedKey", () => {
      const r = ProfileDeleteResponseSchema.safeParse({ ok: true, deletedKey: "role" });
      expect(r.success).toBe(true);
    });

    it("ThreadsDeleteResponseSchema requires ok + deletedCount", () => {
      const r = ThreadsDeleteResponseSchema.safeParse({ ok: true, deletedCount: 3 });
      expect(r.success).toBe(true);
    });
  });
});

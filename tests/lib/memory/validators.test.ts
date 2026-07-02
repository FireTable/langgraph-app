import { describe, expect, it } from "vitest";

import {
  MemoryPatchSchema,
  SaveMemoryInputSchema,
  ProfileResponseSchema,
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

  describe("ProfileResponseSchema", () => {
    it("accepts a full payload", () => {
      const r = ProfileResponseSchema.safeParse({
        profile: { role: "frontend" },
        session: { name: "Yongzhuo", email: "y@example.com", image: null },
        socialAccounts: [{ provider: "github" }],
      });
      expect(r.success).toBe(true);
    });

    it("accepts an empty profile + no social accounts", () => {
      const r = ProfileResponseSchema.safeParse({
        profile: {},
        session: { name: null, email: null, image: null },
        socialAccounts: [],
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
                name: "intro",
                description: "met",
                startMessageIndex: 0,
                endMessageIndex: 6,
                messageCount: 7,
                updatedAt: "2026-07-02T00:00:00.000Z",
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
        name: "intro",
        description: "met",
        startMessageIndex: 0,
        endMessageIndex: 6,
        messageCount: 7,
        updatedAt: "2026-07-02T00:00:00.000Z",
      });
      expect(r.success).toBe(true);
    });

    it("rejects mismatched messageCount", () => {
      const r = SummaryEntrySchema.safeParse({
        threadId: "t1",
        sequence: 1,
        name: "intro",
        description: "met",
        startMessageIndex: 0,
        endMessageIndex: 6,
        messageCount: 5,
        updatedAt: "2026-07-02T00:00:00.000Z",
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock so `vi.mock("@/backend/store")` can see it before the
// SUT imports `store` itself.
const { mockStore } = vi.hoisted(() => ({
  mockStore: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    search: vi.fn(),
    batch: vi.fn(),
  },
}));

vi.mock("@/backend/store", () => ({ store: mockStore }));
vi.mock("@/db/client", () => ({ db: {} }));

import {
  getProfileDoc,
  putProfileDoc,
  deleteProfileField,
  getAllUserSummaries,
  getRecentThreadSummaries,
  deleteThreadSummaries,
  writeSummary,
} from "@/lib/memory/queries";

const USER = "u-test";

beforeEach(() => {
  Object.values(mockStore).forEach((fn) => (fn as ReturnType<typeof vi.fn>).mockReset());
});

describe("lib/memory/queries", () => {
  describe("getProfileDoc", () => {
    it("returns an empty profile when the store has no row", async () => {
      mockStore.get.mockResolvedValueOnce(null);
      const doc = await getProfileDoc(USER);
      expect(doc).toEqual({});
      expect(mockStore.get).toHaveBeenCalledWith([USER, "profile"], "main");
    });

    it("returns the stored value object unwrapped", async () => {
      mockStore.get.mockResolvedValueOnce({
        namespace: [USER, "profile"],
        key: "main",
        value: { role: "frontend", language: "zh" },
        createdAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
      });
      const doc = await getProfileDoc(USER);
      expect(doc).toEqual({ role: "frontend", language: "zh" });
    });
  });

  describe("putProfileDoc", () => {
    it("writes to the canonical namespace + key", async () => {
      mockStore.put.mockResolvedValueOnce(undefined);
      await putProfileDoc(USER, { role: "frontend" });
      expect(mockStore.put).toHaveBeenCalledWith([USER, "profile"], "main", {
        role: "frontend",
      });
    });
  });

  describe("deleteProfileField", () => {
    it("returns null when profile does not exist", async () => {
      mockStore.get.mockResolvedValueOnce(null);
      const result = await deleteProfileField(USER, "role");
      expect(result).toBeNull();
      expect(mockStore.put).not.toHaveBeenCalled();
    });

    it("returns null when key is not in the profile", async () => {
      mockStore.get.mockResolvedValueOnce({
        value: { language: "zh" },
      });
      const result = await deleteProfileField(USER, "role");
      expect(result).toBeNull();
    });

    it("removes the key + writes back the rest", async () => {
      mockStore.get.mockResolvedValueOnce({
        value: { role: "frontend", language: "zh" },
      });
      mockStore.put.mockResolvedValueOnce(undefined);
      const result = await deleteProfileField(USER, "role");
      expect(result).toBe("role");
      expect(mockStore.put).toHaveBeenCalledWith([USER, "profile"], "main", {
        language: "zh",
      });
    });
  });

  describe("writeSummary", () => {
    it("stores under [userId,threads] with composite key + ISO updatedAt", async () => {
      mockStore.put.mockResolvedValueOnce(undefined);
      const written = await writeSummary(USER, {
        threadId: "t1",
        sequence: 1,
        name: "intro",
        description: "met",
        startMessageIndex: 0,
        endMessageIndex: 6,
        messageCount: 7,
      } as never);
      expect(written.threadId).toBe("t1");
      expect(written.sequence).toBe(1);
      expect(typeof (written as { updatedAt: string }).updatedAt).toBe("string");
      expect(mockStore.put).toHaveBeenCalledWith([USER, "threads"], "t1:1", written);
    });
  });

  describe("getAllUserSummaries", () => {
    it("returns the parsed summaries", async () => {
      mockStore.search.mockResolvedValueOnce([
        {
          namespace: [USER, "threads"],
          key: "t1:1",
          value: {
            threadId: "t1",
            sequence: 1,
            name: "intro",
            description: "met",
            startMessageIndex: 0,
            endMessageIndex: 6,
            messageCount: 7,
            updatedAt: "2026-07-02T00:00:00.000Z",
          },
          createdAt: "2026-07-02T00:00:00.000Z",
          updatedAt: "2026-07-02T00:00:00.000Z",
        },
      ]);
      const summaries = await getAllUserSummaries(USER);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.key).toBe("t1:1");
      expect(summaries[0]?.value.threadId).toBe("t1");
    });

    it("skips corrupt summaries (zod fails) and keeps the rest", async () => {
      mockStore.search.mockResolvedValueOnce([
        {
          key: "t1:1",
          value: { corrupt: true },
        },
        {
          key: "t2:1",
          value: {
            threadId: "t2",
            sequence: 1,
            name: "followup",
            description: "x",
            startMessageIndex: 0,
            endMessageIndex: 0,
            messageCount: 1,
            updatedAt: "2026-07-02T00:00:00.000Z",
          },
        },
      ]);
      const summaries = await getAllUserSummaries(USER);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.key).toBe("t2:1");
    });
  });

  describe("getRecentThreadSummaries", () => {
    it("orders by updatedAt desc and returns top-K", async () => {
      mockStore.search.mockResolvedValueOnce([
        { key: "t1:1", value: makeSummary("t1", 1, "2026-07-01T00:00:00.000Z") },
        { key: "t2:1", value: makeSummary("t2", 1, "2026-07-02T00:00:00.000Z") },
        { key: "t3:1", value: makeSummary("t3", 1, "2026-06-30T00:00:00.000Z") },
      ]);
      const top = await getRecentThreadSummaries(USER, 2);
      expect(top.map((s) => s.key)).toEqual(["t2:1", "t1:1"]);
    });
  });

  describe("deleteThreadSummaries", () => {
    it("returns 0 when no summaries for the thread", async () => {
      mockStore.search.mockResolvedValueOnce([]);
      const n = await deleteThreadSummaries(USER, "t1");
      expect(n).toBe(0);
      expect(mockStore.batch).not.toHaveBeenCalled();
    });

    it("batches a delete for every matching key and reports the count", async () => {
      mockStore.search.mockResolvedValueOnce([
        { key: "t1:1", value: makeSummary("t1", 1, "2026-07-02T00:00:00.000Z") },
        { key: "t1:2", value: makeSummary("t1", 2, "2026-07-02T00:00:00.000Z") },
        { key: "t2:1", value: makeSummary("t2", 1, "2026-07-02T00:00:00.000Z") },
      ]);
      mockStore.batch.mockResolvedValueOnce(undefined);
      const n = await deleteThreadSummaries(USER, "t1");
      expect(n).toBe(2);
      expect(mockStore.batch).toHaveBeenCalledTimes(1);
      const ops = mockStore.batch.mock.calls[0]?.[0] as Array<unknown>;
      expect(ops).toHaveLength(2);
    });
  });
});

function makeSummary(threadId: string, sequence: number, updatedAt: string) {
  return {
    threadId,
    sequence,
    name: "n",
    description: "d",
    startMessageIndex: 0,
    endMessageIndex: 0,
    messageCount: 1,
    updatedAt,
  };
}

afterEach(() => {
  Object.values(mockStore).forEach((fn) => (fn as ReturnType<typeof vi.fn>).mockReset());
});

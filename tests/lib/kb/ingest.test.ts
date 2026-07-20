// Mock the shared SDK Client so we can assert what fireIngestionRun
// dispatches without standing up a real langgraphjs dev server.
// ponytail: declare the mock procedure types up front so vi.fn preserves
// the arg / return shapes — without the generics vi.fn() resolves to
// `Mock<[], any>` and mock.calls[0] becomes a 0-length tuple, breaking
// the indexed access below at typecheck.
type RunsCreatePayload = {
  input: {
    messages: Array<{ id?: string; type: string; content: Array<Record<string, unknown>> }>;
  };
  config: {
    configurable: {
      userId: string;
      thread_id: string;
      docId: string;
      mode: string;
      forceRerun?: boolean;
    };
  };
  metadata: {
    source: string;
    docId: string;
    title: string;
    parent_message_id: string;
  };
  multitaskStrategy?: "enqueue" | "interrupt" | "rollback" | "reject";
};
type RunsCreateFn = (
  threadId: string,
  assistantId: string,
  payload: RunsCreatePayload,
) => Promise<{ run_id: string }>;

const { mockRunsCreate, mockThreadsCreate, mockDbThreadsInsert } = vi.hoisted(() => ({
  mockRunsCreate: vi.fn<RunsCreateFn>(async () => ({ run_id: "ignored" })),
  mockThreadsCreate: vi.fn(async () => ({ thread_id: "ignored" })),
  mockDbThreadsInsert: vi.fn(async () => []),
}));
vi.mock("@/lib/langgraph/client", () => ({
  langGraphClient: {
    threads: { create: mockThreadsCreate },
    runs: { create: mockRunsCreate },
  },
}));
// ponytail: ingest.ts now owns the threads-row upsert (moved out of
// prepareKBDataNode). Mock the DB call so the test stays an HTTP-layer
// fixture — no real DB connection needed for ingest.run's payload shape.
vi.mock("@/db/client", () => ({
  db: {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => mockDbThreadsInsert(),
      }),
    }),
  },
}));

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fireIngestionRun, type IngestionAttachment } from "@/lib/kb/ingest";

const ATTACHMENT: IngestionAttachment = {
  r2Key: "kb-tmp/user-1/d-abc/page-1.png",
  contentType: "application/pdf",
  name: "resume.pdf",
};

beforeEach(() => {
  mockRunsCreate.mockClear();
});

describe("lib/kb/ingest", () => {
  describe("fireIngestionRun", () => {
    it("invokes the kbAgent assistant directly (not the full mainAgent)", async () => {
      await fireIngestionRun({
        userId: "user-1",
        attachment: ATTACHMENT,
        docId: "d-abc",
        title: "resume.pdf",
      });
      expect(mockRunsCreate).toHaveBeenCalledTimes(1);
      const [_threadId, assistantId, payload] = mockRunsCreate.mock.calls[0];
      expect(assistantId).toBe("kbAgent");
      expect(payload).toBeDefined();
      void _threadId;
    });

    it("derives threadId from docId by stripping the d- prefix", async () => {
      await fireIngestionRun({
        userId: "user-1",
        attachment: ATTACHMENT,
        docId: "d-abc",
        title: "resume.pdf",
      });
      const [threadId] = mockRunsCreate.mock.calls[0];
      // ponytail: stable threadId across reprocess → observability
      // spans accumulate under the same thread; Settings page
      // reuses docId's UUID to find observability.
      expect(threadId).toBe("abc");
      const payload = mockRunsCreate.mock.calls[0][2];
      expect(payload.config.configurable.thread_id).toBe("abc");
    });

    it("passes multitaskStrategy 'interrupt' so a fresh reprocess aborts a prior in-flight run", async () => {
      await fireIngestionRun({
        userId: "user-1",
        attachment: ATTACHMENT,
        docId: "d-abc",
        title: "resume.pdf",
      });
      const payload = mockRunsCreate.mock.calls[0][2];
      expect(payload.multitaskStrategy).toBe("interrupt");
    });

    it("stamps the synthetic HumanMessage with a per-run id (CapturingHandler pmid)", async () => {
      await fireIngestionRun({
        userId: "user-1",
        attachment: ATTACHMENT,
        docId: "d-abc",
        title: "resume.pdf",
      });
      const payload = mockRunsCreate.mock.calls[0][2];
      expect(payload.input.messages).toHaveLength(1);
      const msg = payload.input.messages[0];
      // ponytail: lastHumanMessageId walks messages for the most recent
      // human + reads m.id — without a non-empty id, handler leaves
      // meta.parent_message_id null and the per-turn panel route 404s.
      expect(msg.type).toBe("human");
      expect(typeof msg.id).toBe("string");
      expect(msg.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("threads parent_message_id into run metadata so the per-turn panel can scope spans", async () => {
      await fireIngestionRun({
        userId: "user-1",
        attachment: ATTACHMENT,
        docId: "d-abc",
        title: "resume.pdf",
      });
      const payload = mockRunsCreate.mock.calls[0][2];
      expect(payload.metadata.parent_message_id).toBe(payload.input.messages[0].id);
      expect(payload.metadata.docId).toBe("d-abc");
      expect(payload.metadata.title).toBe("resume.pdf");
      expect(payload.metadata.source).toBe("kb-upload");
    });

    it("sends a single HumanMessage with a text+file content array (kbAgent wire format)", async () => {
      await fireIngestionRun({
        userId: "user-1",
        attachment: ATTACHMENT,
        docId: "d-abc",
        title: "resume.pdf",
      });
      const payload = mockRunsCreate.mock.calls[0][2];
      expect(payload.input.messages).toHaveLength(1);
      const msg = payload.input.messages[0];
      expect(msg.content[0]).toMatchObject({ type: "text" });
      // File part carries the public R2 URL + contentType + filename.
      expect(msg.content[1]).toMatchObject({
        type: "file",
        data: expect.stringContaining(ATTACHMENT.r2Key) as unknown as string,
        mime_type: ATTACHMENT.contentType,
        filename: `[kb:d-abc] ${ATTACHMENT.name}`,
        metadata: { filename: `[kb:d-abc] ${ATTACHMENT.name}` },
      });
    });

    it("threads source='kb-reprocess' when dispatched from the reprocess route", async () => {
      await fireIngestionRun({
        userId: "user-1",
        attachment: ATTACHMENT,
        docId: "d-abc",
        title: "resume.pdf",
        source: "kb-reprocess",
        mode: "chunksOnly",
      });
      const payload = mockRunsCreate.mock.calls[0][2];
      expect(payload.metadata.source).toBe("kb-reprocess");
      expect(payload.config.configurable.mode).toBe("chunksOnly");
      expect(payload.config.configurable.forceRerun).toBe(true);
    });

    it("forwards userId + thread_id via config.configurable for kbAgent to read", async () => {
      await fireIngestionRun({
        userId: "user-1",
        attachment: ATTACHMENT,
        docId: "d-abc",
        title: "resume.pdf",
      });
      const payload = mockRunsCreate.mock.calls[0][2];
      expect(payload.config.configurable.userId).toBe("user-1");
      expect(payload.config.configurable.thread_id).toBe("abc");
    });
  });
});

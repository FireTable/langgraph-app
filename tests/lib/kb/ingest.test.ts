// Mock the shared SDK Client so we can assert what fireIngestionRun
// dispatches without standing up a real langgraphjs dev server. Threads
// create + runs create are the only surface the upload flow touches.
// ponytail: declare the mock procedure types up front so vi.fn preserves
// the arg / return shapes — without the generics vi.fn() resolves to
// `Mock<[], any>` and mock.calls[0] becomes a 0-length tuple, breaking
// the indexed access below at typecheck. vitest 4's `fn<T>` takes one
// type arg (a Procedure or Constructable), not a tuple.
type ThreadsCreateFn = (args: {
  threadId: string;
  ifExists?: "raise" | "do_nothing";
}) => Promise<{ thread_id: string }>;
type RunsCreatePayload = {
  input: { messages: Array<{ type: string; content: Array<Record<string, unknown>> }> };
  config: { configurable: { userId: string; thread_id: string } };
  metadata: { source: string; docId: string; title: string };
};
type RunsCreateFn = (
  threadId: string,
  assistantId: string,
  payload: RunsCreatePayload,
) => Promise<{ run_id: string }>;

const { mockThreadsCreate, mockRunsCreate } = vi.hoisted(() => ({
  mockThreadsCreate: vi.fn<ThreadsCreateFn>(async (args) => ({
    thread_id: args.threadId,
  })),
  mockRunsCreate: vi.fn<RunsCreateFn>(async () => ({ run_id: "ignored" })),
}));
vi.mock("@/lib/langgraph/client", () => ({
  langGraphClient: {
    threads: { create: mockThreadsCreate },
    runs: { create: mockRunsCreate },
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
  mockThreadsCreate.mockClear();
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

    it("registers a fresh thread id with the dev server before dispatching", async () => {
      await fireIngestionRun({
        userId: "user-1",
        attachment: ATTACHMENT,
        docId: "d-abc",
        title: "resume.pdf",
      });
      expect(mockThreadsCreate).toHaveBeenCalledTimes(1);
      // ponytail: helper passes the same threadId it minted to
      // threads.create → runs.create so the LangGraph run lands on the
      // just-registered thread. Mock setup echoes the id back so this
      // equality is observable.
      const registered = mockThreadsCreate.mock.calls[0][0].threadId;
      expect(mockRunsCreate.mock.calls[0][0]).toBe(registered);
    });

    it("sends a single HumanMessage with a text+file content array (kbAgent wire format)", async () => {
      await fireIngestionRun({
        userId: "user-1",
        attachment: ATTACHMENT,
        docId: "d-abc",
        title: "resume.pdf",
      });
      const payload = mockRunsCreate.mock.calls[0][2] as {
        input: { messages: Array<{ type: string; content: Array<Record<string, unknown>> }> };
      };
      expect(payload.input.messages).toHaveLength(1);
      const msg = payload.input.messages[0];
      expect(msg.type).toBe("human");
      expect(msg.content[0]).toMatchObject({ type: "text" });
      // File part carries the public R2 URL + contentType + filename —
      // screenshotNode uses data, ocrNode uses mime_type, the chunk
      // stage uses filename as a fallback title.
      expect(msg.content[1]).toMatchObject({
        type: "file",
        data: expect.stringContaining(ATTACHMENT.r2Key) as unknown as string,
        mime_type: ATTACHMENT.contentType,
        filename: ATTACHMENT.name,
      });
    });

    it("threads docId + title into run metadata for observability and the Settings UI refresh", async () => {
      await fireIngestionRun({
        userId: "user-1",
        attachment: ATTACHMENT,
        docId: "d-abc",
        title: "Renamed.pdf",
      });
      const payload = mockRunsCreate.mock.calls[0][2] as {
        metadata: { source: string; docId: string; title: string };
      };
      expect(payload.metadata).toEqual({
        source: "kb-settings",
        docId: "d-abc",
        title: "Renamed.pdf",
      });
    });

    it("forwards userId + thread_id via config.configurable for kbAgent to read", async () => {
      await fireIngestionRun({
        userId: "user-1",
        attachment: ATTACHMENT,
        docId: "d-abc",
        title: "resume.pdf",
      });
      const payload = mockRunsCreate.mock.calls[0][2] as {
        config: { configurable: { userId: string; thread_id: string } };
      };
      expect(payload.config.configurable.userId).toBe("user-1");
      expect(payload.config.configurable.thread_id).toBeTruthy();
    });
  });
});

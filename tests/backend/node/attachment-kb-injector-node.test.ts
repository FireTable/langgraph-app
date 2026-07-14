import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HumanMessage, AIMessage, type BaseMessage } from "@langchain/core/messages";

import { setKbStoreRoot } from "@/lib/kb/store";
import { attachmentKbInjectorNode } from "@/backend/node/attachment-kb-injector-node";

const { mockKbInvoke, mockR2Get, mockFindAttachment, mockInsertAttachment } = vi.hoisted(() => ({
  mockKbInvoke: vi.fn(),
  mockR2Get: vi.fn(),
  mockFindAttachment: vi.fn(),
  mockInsertAttachment: vi.fn(),
}));

vi.mock("@/backend/agent/kb-agent", () => ({
  graph: { invoke: (...args: unknown[]) => mockKbInvoke(...args) },
}));

vi.mock("@/lib/r2/client", () => ({
  getObject: (...args: unknown[]) => mockR2Get(...args),
}));

vi.mock("@/lib/attachments/queries", () => ({
  // ponytail: we don't import findAttachmentByR2Key at module-load time,
  // the injector calls it via the named import. The mock returns
  // rows from the hoisted state so the test can simulate "user has
  // uploaded this PDF" / "no row".
  findAttachmentByR2Key: (...args: unknown[]) => mockFindAttachment(...args),
  insertAttachment: (...args: unknown[]) => mockInsertAttachment(...args),
}));

let storeRoot = "";
beforeEach(() => {
  storeRoot = mkdtempSync(join(tmpdir(), "kb-injector-store-"));
  setKbStoreRoot(storeRoot);
  mockKbInvoke.mockReset();
  mockR2Get.mockReset();
  mockFindAttachment.mockReset();
  mockInsertAttachment.mockReset();
});
afterEach(() => {
  rmSync(storeRoot, { recursive: true, force: true });
});

const userId = "user-1";

function filePart(filename: string, publicUrl: string, mimeType = "application/pdf") {
  return { type: "file" as const, data: publicUrl, mimeType, filename };
}

function r2KeyFromUrl(publicUrl: string): string {
  // https://<base>/<key> → key
  return publicUrl.split("/").slice(3).join("/");
}

describe("attachmentKbInjectorNode", () => {
  it("passes through messages with no file parts", async () => {
    const messages: BaseMessage[] = [
      new HumanMessage("what's the weather?"),
      new AIMessage("sunny"),
    ];
    const result = await attachmentKbInjectorNode({ messages }, { configurable: { userId } });
    expect(result.messages ?? []).toHaveLength(0);
    expect(mockKbInvoke).not.toHaveBeenCalled();
  });

  it("leaves non-PDF file parts alone (v1: PDFs only)", async () => {
    const messages: BaseMessage[] = [
      new HumanMessage({
        content: [
          { type: "text", text: "see this image" },
          filePart("photo.jpg", "https://r2.example/u/user-1/abc.jpg", "image/jpeg"),
        ],
      }),
    ];
    const result = await attachmentKbInjectorNode({ messages }, { configurable: { userId } });
    expect(mockKbInvoke).not.toHaveBeenCalled();
    expect(result.messages ?? []).toHaveLength(0);
  });

  it("invokes kb_agent for a PDF file part and rewrites the file part to text", async () => {
    const publicUrl = "https://r2.example/u/user-1/paper.pdf";
    mockFindAttachment.mockResolvedValue({
      id: "att-1",
      userId,
      r2Key: "u/user-1/paper.pdf",
      name: "paper.pdf",
      contentType: "application/pdf",
      sha256: "abc",
      sizeBytes: 1000,
      status: "uploaded",
      createdAt: new Date(),
      confirmedAt: new Date(),
    });
    mockR2Get.mockResolvedValue(Buffer.from("%PDF-1.4\nfake"));
    mockKbInvoke.mockResolvedValue({
      docId: "doc-1",
      pages: [
        { pageIndex: 0, imagePath: "/tmp/x.png", markdown: "# Title\n\nFirst page text" },
        { pageIndex: 1, imagePath: "/tmp/y.png", markdown: "Second page text" },
      ],
      chunks: [],
      status: "ready",
      errorMessage: null,
    });

    const messages: BaseMessage[] = [
      new HumanMessage({
        content: [
          { type: "text", text: "summarize this PDF" },
          filePart("paper.pdf", publicUrl, "application/pdf"),
        ],
      }),
    ];
    const result = await attachmentKbInjectorNode({ messages }, { configurable: { userId } });

    expect(mockKbInvoke).toHaveBeenCalledTimes(1);
    const callInput = mockKbInvoke.mock.calls[0][0] as Record<string, unknown>;
    expect(callInput.userId).toBe(userId);
    expect(callInput.title).toBe("paper.pdf");
    expect(callInput.contentType).toBe("application/pdf");
    expect(Buffer.isBuffer(callInput.pdfBytes)).toBe(true);

    // result.messages should be a new array with the file part replaced
    expect(result.messages).toHaveLength(1);
    const newContent = (result.messages![0] as HumanMessage).content;
    expect(Array.isArray(newContent)).toBe(true);
    const arr = newContent as Array<{ type: string; text?: string }>;
    // Text prefix preserved, file part replaced with markdown text
    expect(arr[0]).toMatchObject({ type: "text", text: "summarize this PDF" });
    expect(arr[1]).toMatchObject({ type: "text" });
    expect((arr[1] as { text: string }).text).toContain("# Title");
    expect((arr[1] as { text: string }).text).toContain("First page text");
    expect((arr[1] as { text: string }).text).toContain("Second page text");
  });

  it("drops the file part silently if the attachment doesn't belong to the user", async () => {
    const publicUrl = "https://r2.example/u/other-user/paper.pdf";
    mockFindAttachment.mockResolvedValue(null);

    const messages: BaseMessage[] = [
      new HumanMessage({
        content: [
          { type: "text", text: "summarize this" },
          filePart("paper.pdf", publicUrl, "application/pdf"),
        ],
      }),
    ];
    const result = await attachmentKbInjectorNode({ messages }, { configurable: { userId } });
    expect(mockKbInvoke).not.toHaveBeenCalled();
    // No replacement happens → state.messages unchanged
    expect(result.messages ?? []).toHaveLength(0);
  });

  it("rewrites the file part to a 'KB processing failed' text when kb_agent returns status=failed", async () => {
    const publicUrl = "https://r2.example/u/user-1/paper.pdf";
    mockFindAttachment.mockResolvedValue({
      id: "att-1",
      userId,
      r2Key: "u/user-1/paper.pdf",
      name: "paper.pdf",
      contentType: "application/pdf",
      sha256: "abc",
      sizeBytes: 1000,
      status: "uploaded",
      createdAt: new Date(),
      confirmedAt: new Date(),
    });
    mockR2Get.mockResolvedValue(Buffer.from("%PDF-1.4\nfake"));
    mockKbInvoke.mockResolvedValue({
      docId: "doc-1",
      pages: [],
      chunks: [],
      status: "failed",
      errorMessage: "vlm exploded",
    });

    const messages: BaseMessage[] = [
      new HumanMessage({
        content: [filePart("paper.pdf", publicUrl, "application/pdf")],
      }),
    ];
    const result = await attachmentKbInjectorNode({ messages }, { configurable: { userId } });
    const arr = (result.messages![0] as HumanMessage).content as Array<{
      type: string;
      text?: string;
    }>;
    expect(arr[0].type).toBe("text");
    expect(arr[0].text).toMatch(/KB processing failed.*vlm exploded/);
  });
});

// ponytail: keep the r2Key helper private to the test so a future
// refactor of the URL format (e.g. signed CDN URL) doesn't leak.
void r2KeyFromUrl;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setKbStoreRoot, type KbDocRecord } from "@/lib/kb/store";
import { graph as kbAgentGraph } from "@/backend/kb-agent";

const { mockVlmInvoke, mockEmbedDocuments } = vi.hoisted(() => ({
  mockVlmInvoke: vi.fn(),
  mockEmbedDocuments: vi.fn(),
}));

vi.mock("@/backend/model", () => ({
  getVlmModel: async () => ({
    invoke: (...args: unknown[]) => mockVlmInvoke(...args),
  }),
  getEmbeddingModel: async () => ({
    embedDocuments: (...args: unknown[]) => mockEmbedDocuments(...args),
  }),
}));

let storeRoot = "";
let imgDir = "";

beforeEach(() => {
  storeRoot = mkdtempSync(join(tmpdir(), "kb-agent-store-"));
  setKbStoreRoot(storeRoot);
  imgDir = mkdtempSync(join(tmpdir(), "kb-agent-img-"));
  mockVlmInvoke.mockReset();
  mockEmbedDocuments.mockReset();
});

afterEach(() => {
  rmSync(storeRoot, { recursive: true, force: true });
  rmSync(imgDir, { recursive: true, force: true });
});

// ponytail: same hand-rolled minimal PDF helper as the screenshot test.
// Duplicated instead of shared because the test files live in different
// suites and a shared helper would add a `tests/helpers` file for two
// callers — not worth it for v1.
function makeMinimalPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
  ];
  const header = "%PDF-1.4\n";
  const bodyParts: string[] = [];
  let offset = Buffer.byteLength(header, "binary");
  const xrefEntries: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    const objStr = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    xrefEntries.push(offset);
    bodyParts.push(objStr);
    offset += Buffer.byteLength(objStr, "binary");
  }
  const body = bodyParts.join("");
  const xrefStart = Buffer.byteLength(header, "binary") + Buffer.byteLength(body, "binary");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of xrefEntries) {
    xref += off.toString().padStart(10, "0") + " 00000 n \n";
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(header + body + xref + trailer, "binary");
}

const baseInput = () => ({
  userId: "user-1",
  attachmentId: "att-1",
  sourceUrl: null,
  title: "test.pdf",
  contentType: "application/pdf",
  contentHash: "abc123",
  pdfBytes: makeMinimalPdf(),
  docId: "doc-1",
});

describe("kb_agent subgraph", () => {
  it("screenshot → vlm → chunk-embed-store writes a KbDocRecord JSON", async () => {
    mockVlmInvoke.mockResolvedValue(new AIMessage("# Heading\n\nHello world"));
    mockEmbedDocuments.mockResolvedValue([[0.1, 0.2, 0.3]]);

    const result = await kbAgentGraph.invoke(baseInput());

    // Status flipped to ready.
    expect(result.status).toBe("ready");
    expect(result.errorMessage).toBeNull();

    // JSON file persisted under per-user path.
    const onDisk = JSON.parse(
      readFileSync(join(storeRoot, "user-1", "doc-1.json"), "utf8"),
    ) as KbDocRecord;
    expect(onDisk.status).toBe("ready");
    expect(onDisk.id).toBe("doc-1");
    expect(onDisk.userId).toBe("user-1");
    expect(onDisk.title).toBe("test.pdf");
    expect(onDisk.contentHash).toBe("abc123");
    expect(onDisk.pages).toHaveLength(1);
    expect(onDisk.pages[0].markdown).toBe("# Heading\n\nHello world");
    expect(onDisk.chunks).toHaveLength(1);
    expect(onDisk.chunks[0].content).toBe("# Heading\n\nHello world");
    expect(onDisk.chunks[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(onDisk.chunks[0].ordinal).toBe(0);
    expect(onDisk.chunks[0].id).toMatch(/^c-/);
  });

  it("calls the VLM once per page", async () => {
    mockVlmInvoke.mockResolvedValue(new AIMessage("page text"));
    mockEmbedDocuments.mockResolvedValue([[0.1, 0.2]]);

    // 2-page PDF by repeating the minimal PDF body — mupdf counts the
    // pages from the /Pages /Kids array, so a hand-rolled 2-kid doc
    // works without a real 2-page content stream.
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ];
    const header = "%PDF-1.4\n";
    const bodyParts: string[] = [];
    let offset = Buffer.byteLength(header, "binary");
    const xrefEntries: number[] = [];
    for (let i = 0; i < objects.length; i++) {
      const objStr = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
      xrefEntries.push(offset);
      bodyParts.push(objStr);
      offset += Buffer.byteLength(objStr, "binary");
    }
    const body = bodyParts.join("");
    const xrefStart = Buffer.byteLength(header, "binary") + Buffer.byteLength(body, "binary");
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of xrefEntries) {
      xref += off.toString().padStart(10, "0") + " 00000 n \n";
    }
    const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    const twoPagePdf = Buffer.from(header + body + xref + trailer, "binary");

    const result = await kbAgentGraph.invoke({
      ...baseInput(),
      pdfBytes: twoPagePdf,
    });
    expect(mockVlmInvoke).toHaveBeenCalledTimes(2);
    expect(result.pages).toHaveLength(2);
    expect(result.chunks).toHaveLength(2);
  });

  it("persists status=failed and surfaces errorMessage when VLM throws", async () => {
    mockVlmInvoke.mockRejectedValue(new Error("vlm exploded"));
    mockEmbedDocuments.mockResolvedValue([]);

    const result = await kbAgentGraph.invoke(baseInput());
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/vlm exploded/);
  });
});

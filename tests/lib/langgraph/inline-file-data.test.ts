import { afterEach, describe, expect, it, vi } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { inlineFileData } from "@/lib/langgraph/inline-file-data";

const originalFetch = global.fetch;

function mockFetchOnce(
  body: ArrayBuffer | string,
  opts: { status?: number; contentLength?: number } = {},
) {
  const buf = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
  const res = new Response(buf, {
    status: opts.status ?? 200,
    headers: { "Content-Length": String(opts.contentLength ?? buf.byteLength) },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(res));
}

afterEach(() => {
  vi.unstubAllGlobals();
  global.fetch = originalFetch;
});

describe("inlineFileData", () => {
  it("returns the input unchanged when content is a plain string", async () => {
    const m = new HumanMessage("hello");
    const out = await inlineFileData([m]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(m);
  });

  it("returns the input unchanged when no file parts are present", async () => {
    const m = new HumanMessage([{ type: "text", text: "just text" }]);
    const out = await inlineFileData([m]);
    expect(out[0]).toBe(m);
  });

  it("fetches a file URL and replaces data with a base64 data URL", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    mockFetchOnce(pdfBytes.buffer, { contentLength: pdfBytes.byteLength });
    const m = new HumanMessage([
      { type: "text", text: "这是什么内容" },
      {
        type: "file",
        data: "https://file.example/x.pdf",
        mime_type: "application/pdf",
        metadata: { filename: "Binance.pdf" },
      },
    ]);
    const out = await inlineFileData([m]);
    const content = out[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "这是什么内容" });
    const filePart = content[1] as Record<string, unknown>;
    expect(typeof filePart.data).toBe("string");
    expect((filePart.data as string).startsWith("data:application/pdf;base64,")).toBe(true);
    // The base64 of %PDF- is "JVBERi0="
    expect(filePart.data).toBe("data:application/pdf;base64,JVBERi0=");
    // filename metadata preserved
    expect((filePart.metadata as { filename?: string }).filename).toBe("Binance.pdf");
  });

  it("leaves already-inlined data: URLs alone (idempotent)", async () => {
    const m = new HumanMessage([
      {
        type: "file",
        data: "data:application/pdf;base64,JVBERi0=",
        mime_type: "application/pdf",
      },
    ]);
    const out = await inlineFileData([m]);
    const content = out[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toBe(m.content[0]);
  });

  it("replaces oversized files (>2 MiB) with a marker text part", async () => {
    // Mock returns content-length above the cap
    mockFetchOnce(new ArrayBuffer(0), { contentLength: 3 * 1024 * 1024 });
    const m = new HumanMessage([
      {
        type: "file",
        data: "https://file.example/huge.pdf",
        mime_type: "application/pdf",
        metadata: { filename: "huge.pdf" },
      },
    ]);
    const out = await inlineFileData([m]);
    const content = out[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    const text = (content[0] as { text: string }).text;
    expect(text).toMatch(/file too large to inline/);
    expect(text).toContain("huge.pdf");
  });

  it("replaces the file part with a fetch-error marker when R2 returns non-200", async () => {
    mockFetchOnce("not found", { status: 404 });
    const m = new HumanMessage([
      { type: "file", data: "https://file.example/missing.pdf", mime_type: "application/pdf" },
    ]);
    const out = await inlineFileData([m]);
    const content = out[0].content as Array<Record<string, unknown>>;
    const text = (content[0] as { text: string }).text;
    expect(text).toMatch(/\[fetch 404\]/);
  });

  it("preserves id and additional_kwargs on the reconstructed message", async () => {
    mockFetchOnce(new Uint8Array([0x25, 0x50]).buffer);
    const m = new HumanMessage({
      content: [{ type: "file", data: "https://x/y.png", mime_type: "image/png" }],
      id: "msg-1",
      additional_kwargs: { source: "user" },
    });
    const out = await inlineFileData([m]);
    expect(out[0].id).toBe("msg-1");
    expect(out[0].additional_kwargs).toEqual({ source: "user" });
  });

  it("handles a mix of text, file, and image parts in one message", async () => {
    mockFetchOnce(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer);
    const m = new HumanMessage([
      { type: "text", text: "analyze" },
      { type: "image", image: "https://x/y.jpg" }, // already URL — leave alone
      { type: "file", data: "https://x/z.pdf", mime_type: "application/pdf" },
    ]);
    const out = await inlineFileData([m]);
    const content = out[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "analyze" });
    expect((content[1] as Record<string, unknown>).image).toBe("https://x/y.jpg");
    expect((content[2] as Record<string, unknown>).data).toMatch(/^data:application\/pdf;base64,/);
  });

  it("does not mutate messages without file parts (reference equality)", async () => {
    const ai = new AIMessage("hi");
    const out = await inlineFileData([ai]);
    expect(out[0]).toBe(ai);
  });
});

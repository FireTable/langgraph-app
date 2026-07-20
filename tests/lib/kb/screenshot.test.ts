import { describe, expect, it } from "vitest";

import { screenshotPdf } from "@/lib/kb/screenshot";

// ponytail: v2 screenshot returns Buffers, no disk writes. The
// fixtures are minimal hand-rolled PDFs (1 page, 612x792 = US Letter).
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

describe("screenshotPdf", () => {
  it("renders a 1-page PDF to one PNG buffer", async () => {
    const pdf = makeMinimalPdf();
    const pages = await screenshotPdf({ pdfBytes: pdf, dpi: 72 });
    expect(pages).toHaveLength(1);
    expect(pages[0].pageIndex).toBe(0);
    expect(Buffer.isBuffer(pages[0].png)).toBe(true);
    expect(pages[0].png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("DPI scales the output buffer size", async () => {
    const pdf = makeMinimalPdf();
    const lowDpi = await screenshotPdf({ pdfBytes: pdf, dpi: 72 });
    const highDpi = await screenshotPdf({ pdfBytes: pdf, dpi: 200 });
    expect(highDpi[0].png.length).toBeGreaterThan(lowDpi[0].png.length);
  });

  it("throws a clear error for non-PDF bytes", async () => {
    const garbage = Buffer.from("not a pdf at all");
    await expect(screenshotPdf({ pdfBytes: garbage, dpi: 72 })).rejects.toThrow(/pdf/i);
  });
});

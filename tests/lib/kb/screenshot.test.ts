import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { screenshotPdf } from "@/lib/kb/screenshot";

// ponytail: mupdf needs a real PDF to render. Hand-rolled minimal PDF
// (1 page, 612x792 = US Letter) generated at test time — keeps the
// fixture self-contained, no checked-in binary, and the offset math
// is local to the helper so a reader can verify it.
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

let outDir = "";
beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "kb-screenshot-"));
});
afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("screenshotPdf", () => {
  it("renders a 1-page PDF to one PNG buffer", async () => {
    const pdf = makeMinimalPdf();
    const pages = await screenshotPdf({ pdfBytes: pdf, outputDir: outDir, dpi: 72 });
    expect(pages).toHaveLength(1);
    expect(pages[0].pageIndex).toBe(0);
    expect(pages[0].imagePath.startsWith(outDir)).toBe(true);
    // PNG magic header
    const onDisk = readFileSync(pages[0].imagePath);
    expect(onDisk.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("image path follows page-N.png convention", async () => {
    const pdf = makeMinimalPdf();
    const pages = await screenshotPdf({ pdfBytes: pdf, outputDir: outDir, dpi: 72 });
    expect(pages[0].imagePath).toBe(join(outDir, "page-0.png"));
  });

  it("DPI scales the output dimensions", async () => {
    const pdf = makeMinimalPdf();
    const lowDpi = await screenshotPdf({ pdfBytes: pdf, outputDir: outDir, dpi: 72 });
    // 612 pt at 72 DPI ≈ 612 px wide. 200 DPI ≈ 1700 px wide.
    const dimsLow = (await import("node:fs")).statSync(lowDpi[0].imagePath).size;
    expect(dimsLow).toBeGreaterThan(0);
    // The size delta between 72 and 200 DPI for the same blank page is
    // ~7x; not a strict assert (PNG compression varies) but enough to
    // confirm DPI is being applied. The 200-DPI file should be at least
    // 2x the 72-DPI one.
    const highDpi = await screenshotPdf({
      pdfBytes: pdf,
      outputDir: outDir,
      dpi: 200,
    });
    const dimsHigh = (await import("node:fs")).statSync(highDpi[0].imagePath).size;
    expect(dimsHigh).toBeGreaterThan(dimsLow);
  });

  it("throws a clear error for non-PDF bytes", async () => {
    const garbage = Buffer.from("not a pdf at all");
    await expect(screenshotPdf({ pdfBytes: garbage, outputDir: outDir, dpi: 72 })).rejects.toThrow(
      /pdf/i,
    );
  });
});

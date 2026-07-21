import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

// ponytail: extractPdfImages runs `page.run(device, matrix)` and the
// device's `fillImage(image, ctm, alpha)` callback. We mock the mupdf
// module to expose a fake Page whose `run()` invokes the device's
// callback synchronously with hand-rolled Image + Matrix objects, so
// the test pinpoints: bbox derivation from ctm, png export, name
// scheme, multi-image grouping by page.

type FakeImage = { getWidth: () => number; getHeight: () => number; toPixmap: () => { asPNG: () => Uint8Array } };
type FakeMatrix = [number, number, number, number, number, number];
type FillImageFn = (image: FakeImage, ctm: FakeMatrix, alpha: number) => void;
type FakeDevice = { fillImage?: FillImageFn; callbacks?: FakeDevice };
type FakePage = { run: (device: FakeDevice, matrix: FakeMatrix) => void };
type FakeDoc = { countPages: () => number; loadPage: (i: number) => FakePage };

const docRef: { current: FakeDoc | null } = { current: null };

vi.mock("mupdf", () => {
  class FakeDevice {
    callbacks: FakeDevice;
    constructor(callbacks: FakeDevice) {
      this.callbacks = callbacks;
    }
  }
  return {
    Device: FakeDevice,
    Matrix: {
      identity: [1, 0, 0, 1, 0, 0] as FakeMatrix,
    },
    Document: {
      openDocument: () => docRef.current!,
    },
  };
});

import { extractPdfImages } from "@/lib/kb/pdf-images";

function setupDoc(pages: Array<{
  images: Array<{ width: number; height: number; ctm: FakeMatrix }>;
}>): void {
  docRef.current = {
    countPages: () => pages.length,
    loadPage: (i: number) => ({
      // ponytail: real mupdf invokes the device's registered callbacks
      // during run(); we mirror that by reading the callbacks off the
      // FakeDevice instance passed in.
      run(device: FakeDevice, _matrix: FakeMatrix) {
        for (const img of pages[i].images) {
          device.callbacks?.fillImage?.(
            {
              getWidth: () => img.width,
              getHeight: () => img.height,
              toPixmap: () => ({ asPNG: () => new Uint8Array([1, 2, 3, 4]) }),
            },
            img.ctm,
            1,
          );
        }
      },
    }),
  };
}

describe("extractPdfImages", () => {
  it("returns empty when no page has images", async () => {
    setupDoc([{ images: [] }, { images: [] }]);
    const out = await extractPdfImages({ pdfBytes: Buffer.from("") });
    expect(out).toEqual([]);
  });

  it("captures bbox from identity ctm + native dims", async () => {
    setupDoc([{ images: [{ width: 200, height: 100, ctm: [1, 0, 0, 1, 50, 80] }] }]);
    const out = await extractPdfImages({ pdfBytes: Buffer.from("") });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      pageIndex: 0,
      name: "img-p0-0",
      width: 200,
      height: 100,
      bbox: [50, 80, 250, 180],
    });
    expect(out[0].png).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("handles rotated images (non-axis-aligned ctm)", async () => {
    // ctm = [a, b, c, d, e, f] where (a,b) is x-axis vector, (c,d) is y-axis
    // 90° rotation: x-axis points down (a=0,b=1), y-axis points left (c=1,d=0)
    // For a 100×50 image at origin → corners (0,0), (0,100), (50,100), (50,0)
    setupDoc([{ images: [{ width: 100, height: 50, ctm: [0, 1, -1, 0, 200, 0] }] }]);
    const out = await extractPdfImages({ pdfBytes: Buffer.from("") });
    // bbox = (min_x, min_y, max_x, max_y) over the 4 transformed corners
    // corner1: (a*0 + c*0 + 200, b*0 + d*0 + 0) = (200, 0)
    // corner2: (a*100 + c*0 + 200, b*100 + d*0 + 0) = (200, 100)
    // corner3: (a*100 + c*50 + 200, b*100 + d*50 + 0) = (150, 100)
    // corner4: (a*0 + c*50 + 200, b*0 + d*50 + 0) = (150, 0)
    expect(out[0].bbox).toEqual([150, 0, 200, 100]);
  });

  it("groups images by pageIndex with stable per-page naming", async () => {
    setupDoc([
      {
        images: [
          { width: 50, height: 50, ctm: [1, 0, 0, 1, 0, 0] },
          { width: 60, height: 60, ctm: [1, 0, 0, 1, 100, 100] },
        ],
      },
      { images: [{ width: 70, height: 70, ctm: [1, 0, 0, 1, 200, 200] }] },
    ]);
    const out = await extractPdfImages({ pdfBytes: Buffer.from("") });
    expect(out.map((o) => o.name)).toEqual(["img-p0-0", "img-p0-1", "img-p1-0"]);
    expect(out.map((o) => o.pageIndex)).toEqual([0, 0, 1]);
  });
});
// ponytail: pure front-end-safe helpers — no I/O, no DB, no
// server-only imports. Used by the doc detail dialog to decide
// whether to render Page Image / Reference Text columns, and by
// the add-doc dialog to render the supported-extensions label.
// The ingest-handlers module imports from here for its own routing;
// the frontend imports from here directly. Keeping this file
// dependency-free (no mupdf / R2 / jina) means the client bundle
// stays light.

export type IngestKind = "pdf" | "markdown" | "plain" | "image";

export function getIngestKind(mimeType: string): IngestKind | null {
  const mt = mimeType.toLowerCase();
  if (mt === "application/pdf") return "pdf";
  if (mt === "text/markdown") return "markdown";
  if (mt === "text/plain") return "plain";
  if (mt.startsWith("image/")) return "image";
  return null;
}

export function hasPageImages(kind: IngestKind | null): boolean {
  return kind === "pdf" || kind === "image";
}

export function hasReferenceText(kind: IngestKind | null): boolean {
  return kind === "pdf";
}

// ponytail: per-kind label for the "main content" tab in the doc
// detail dialog. PDF / image OCR output is technically markdown
// too, but a `.txt` file with no markdown structure shouldn't be
// labeled as Markdown.
export function mainContentTabLabel(kind: IngestKind | null): string {
  if (kind === "plain") return "Text";
  return "Markdown";
}

// ponytail: short, uppercase file-type labels for the doc table
// badge and the Add dialog "supports" hint. Single source so the
// "PDF" chip in the table matches the "PDF" hint in the dialog.
const TYPE_LABEL: Record<string, string> = {
  pdf: "PDF",
  markdown: "MD",
  plain: "TXT",
  png: "PNG",
  jpeg: "JPG",
  webp: "WEBP",
};

export function mimeShortLabel(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "";
  return TYPE_LABEL[subtype] ?? (subtype.toUpperCase() || mimeType);
}

// ponytail: turn `R2_ALLOWED_CONTENT_TYPES` (comma-separated mimes)
// into a UI-friendly label list, dropping unknown mimes. Used by
// the Add dialog's "Supports: PDF, MD, ..." hint.
export function formatAcceptList(allowed: string): string[] {
  return allowed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(mimeShortLabel);
}

// ponytail: <input type="file" accept="..."> needs BOTH mime types
// AND file extensions — Chrome on Linux reports text/plain as
// `text/plain`, but Windows sometimes reports an empty MIME for
// `.txt` and macOS reports `text/plain`. Listing both is the only
// way to make the file picker show every supported file on every
// platform.
const MIME_TO_EXT: Record<string, string> = {
  pdf: ".pdf",
  markdown: ".md",
  plain: ".txt",
  png: ".png",
  jpeg: ".jpg",
  webp: ".webp",
};

export function buildAcceptAttribute(allowed: string): string {
  return allowed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((mime) => {
      const subtype = mime.split("/")[1]?.toLowerCase() ?? "";
      const ext = MIME_TO_EXT[subtype];
      return ext ? [mime, ext] : [mime];
    })
    .join(",");
}

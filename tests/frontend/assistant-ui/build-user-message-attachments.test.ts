import { describe, expect, it } from "vitest";
import type { CompleteAttachment } from "@assistant-ui/react";

import { buildUserMessageAttachments } from "@/components/assistant-ui/build-user-message-attachments";

// ponytail: pure projection of message.content → CompleteAttachment[].
// Mirrors the loop body that used to live inside UserMessageAttachments'
// useMemo, hoisted so the kb_ref branch is testable without mounting
// the aUI runtime. image / file branches preserved verbatim.
//
// The aUI runtime's `useAuiState(s => s.message.content)` is typed as
// `readonly (TextMessagePart | ThreadUserMessagePart | ThreadAssistantMessagePart)[]`
// but at runtime it carries our custom kb_ref parts too — we accept
// `readonly unknown[]` here and narrow with structural checks, same as
// the original code did for image/file.

describe("buildUserMessageAttachments", () => {
  it("projects an image part", () => {
    const parts: unknown[] = [{ type: "image", image: "https://r2/foo.png" }];
    const out = buildUserMessageAttachments(parts);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("image");
    expect(out[0]?.name).toBe("foo.png");
    expect(out[0]?.content[0]).toMatchObject({ type: "image", image: "https://r2/foo.png" });
  });

  it("projects a file part, falling back to 'file' when filename is missing", () => {
    const parts: unknown[] = [
      { type: "file", data: "https://r2/a.pdf", mimeType: "application/pdf" },
    ];
    const out = buildUserMessageAttachments(parts);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("file");
    expect(out[0]?.name).toBe("file");
    expect(out[0]?.contentType).toBe("application/pdf");
  });

  it("projects a kb_ref part (runtime-only, not in ThreadUserMessagePart union)", () => {
    const parts: unknown[] = [{ type: "kb_ref", docId: "d-abc" }];
    const out = buildUserMessageAttachments(parts);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("kb_ref");
    expect(out[0]?.id).toBe("kb_ref:d-abc");
    expect(out[0]?.name).toBe("d-abc");
  });

  it("dedupes image parts by url, file parts by filename, kb_ref parts by docId", () => {
    const parts: unknown[] = [
      { type: "image", image: "https://r2/x.png" },
      { type: "image", image: "https://r2/x.png" },
      { type: "file", data: "https://r2/y.pdf", filename: "y.pdf", mimeType: "application/pdf" },
      { type: "file", data: "https://r2/y.pdf", filename: "y.pdf", mimeType: "application/pdf" },
      { type: "kb_ref", docId: "d-1" },
      { type: "kb_ref", docId: "d-1" },
    ];
    const out = buildUserMessageAttachments(parts) as CompleteAttachment[];
    expect(out.map((a) => a.type)).toEqual(["image", "file", "kb_ref"]);
  });

  it("preserves order across heterogeneous parts", () => {
    const parts: unknown[] = [
      { type: "image", image: "https://r2/a.png" },
      { type: "kb_ref", docId: "d-1" },
      { type: "file", data: "https://r2/c.pdf", filename: "c.pdf", mimeType: "application/pdf" },
    ];
    const out = buildUserMessageAttachments(parts) as CompleteAttachment[];
    expect(out.map((a) => a.type)).toEqual(["image", "kb_ref", "file"]);
  });
});

import { unwrapToolResult } from "@/components/tool-ui/tool-result";

import type { KbDocument, KbToolResult, ParseOutcome } from "./types";

export function parseKbResult(raw: unknown): ParseOutcome {
  const obj = unwrapToolResult<Record<string, unknown>>(raw);
  if (!obj) return { kind: "loading" };
  if (obj.empty === true) return { kind: "empty" };
  if (obj.status === "error") {
    const c = obj.content;
    const message = typeof c === "string" ? c.replace(/^Error:\s*/, "").trim() : "Tool failed.";
    return { kind: "error", message };
  }
  if (Array.isArray(obj.documents)) {
    return { kind: "ok", result: obj as unknown as KbToolResult };
  }
  return { kind: "loading" };
}

export function legBadges(legs: KbDocument["legsHit"]): string[] {
  return legs.map((leg) => {
    switch (leg) {
      case "kw":
        return "BM25";
      case "vec":
        return "vector";
      case "tag":
        return "entity";
      case "full":
        return "full doc";
      default:
        return leg;
    }
  });
}

export function chunkPreview(content: string, max = 240): string {
  if (content.length <= max) return content;
  return content.slice(0, max) + "…";
}

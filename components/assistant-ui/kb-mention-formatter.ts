import {
  type Unstable_DirectiveFormatter,
  type Unstable_DirectiveSegment,
} from "@assistant-ui/react";

// ponytail: the key in the brace group matches the search_kb /
// list_documents parameter name so the LLM can copy the value
// directly into the tool call. Doc directive: {documentId=…};
// folder directive: {folderId=…}. No more generic {id=…} — the
// LLM no longer has to guess which arg to pass.

export const kbMentionFormatter: Unstable_DirectiveFormatter = {
  serialize(item) {
    const key = item.type === "kb-folder" ? "folderId" : "documentId";
    return `:${item.type}[${item.label}]{${key}=${item.id}}`;
  },
  parse(text) {
    // ponytail: accept both {documentId=…} / {folderId=…} and the
    // older {id=…} so existing transcript lines (and tests pinned to
    // the old format) keep rendering. The LLM only sees the wire
    // form, so newly serialised chips will all use the typed keys.
    const regex =
      /:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{(?:documentId|folderId|id)=([^}\n]{1,1024})\})?/g;
    const segments: Unstable_DirectiveSegment[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const matchIndex = match.index;
      if (matchIndex > lastIndex) {
        segments.push({
          kind: "text",
          text: text.slice(lastIndex, matchIndex),
        });
      }

      const rawType = match[1]!;
      const type = rawType === "kb-doc" ? "kb-document" : rawType;
      const label = match[2]!;
      const explicitId = match[3];
      const id = explicitId || label; // Fallback to label if no explicit id is provided

      segments.push({
        kind: "mention",
        type,
        id,
        label,
      });

      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      segments.push({
        kind: "text",
        text: text.slice(lastIndex),
      });
    }

    if (segments.length === 0) {
      segments.push({
        kind: "text",
        text,
      });
    }

    return segments;
  },
};

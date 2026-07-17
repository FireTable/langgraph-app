import {
  type Unstable_DirectiveFormatter,
  type Unstable_DirectiveSegment,
} from "@assistant-ui/react";

export const kbMentionFormatter: Unstable_DirectiveFormatter = {
  serialize(item) {
    const type = item.type === "kb-document" ? "kb-doc" : item.type;
    return `:${type}[${item.label}]`;
  },
  parse(text) {
    const regex = /:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?/g;
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

// ponytail: pure message-parsing for LLM spans. No React, no useAui —
// extracted from panel.tsx so the isNew logic can be unit-tested without
// spinning up the AUI runtime.

import type { CapturedSpan } from "@/lib/observability/callback";

export type MessageEntry = { role: string; body: string; isNew?: boolean };

const KNOWN_ROLES = new Set(["system", "human", "ai", "assistant", "tool", "function"]);

function parsePromptGroup(group: string): MessageEntry[] {
  const out: MessageEntry[] = [];
  let current: { role: string; body: string[] } | null = null;
  for (const line of group.split("\n")) {
    const colonAt = line.indexOf(": ");
    const maybeRole = colonAt > 0 ? line.slice(0, colonAt) : "";
    if (KNOWN_ROLES.has(maybeRole)) {
      if (current) out.push({ role: current.role, body: current.body.join("\n") });
      current = { role: maybeRole, body: [line.slice(colonAt + 2)] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) out.push({ role: current.role, body: current.body.join("\n") });
  return out;
}

function readOutputMessages(span: CapturedSpan): MessageEntry[] {
  if (span.kind !== "llm") return [];
  const out = span.output as unknown;
  if (!out || typeof out !== "object") return [];
  const generations = (out as Record<string, unknown>).generations;
  if (!Array.isArray(generations)) return [];
  const entries: MessageEntry[] = [];
  for (const row of generations) {
    if (!Array.isArray(row)) continue;
    for (const gen of row) {
      if (!gen || typeof gen !== "object") continue;
      const msg = (gen as Record<string, unknown>).message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const role =
        typeof (msg as Record<string, unknown>).getType === "function"
          ? ((msg as unknown as { getType: () => string }).getType() as string)
          : typeof msg.role === "string"
            ? (msg.role as string)
            : "ai";
      const raw = msg.content;
      let body = "";
      if (typeof raw === "string") {
        body = raw;
      } else if (Array.isArray(raw)) {
        body = raw
          .map((part) =>
            part && typeof part === "object" && "text" in (part as object)
              ? String((part as Record<string, unknown>).text ?? "")
              : "",
          )
          .filter(Boolean)
          .join("\n");
      } else if (raw && typeof raw === "object") {
        body = JSON.stringify(raw, null, 2);
      }
      const tcs = msg.tool_calls;
      if ((!body || body.trim() === "") && Array.isArray(tcs) && tcs.length > 0) {
        body = tcs
          .map((tc) => {
            const t = tc as { name?: unknown; args?: unknown };
            return `[tool_call ${String(t.name ?? "?")}(${JSON.stringify(t.args ?? {})})]`;
          })
          .join("\n");
      }
      entries.push({ role, body, isNew: true });
    }
  }
  return entries;
}

// ponytail: original semantics — every input entry from the last
// `human:` onward, plus every output entry, is marked NEW. The
// cumulative count across multiple LLM calls in a single turn is
// intentional (each call adds another batch of "new" rows from the
// user's vantage).
export function buildLlmMessages(span: CapturedSpan): MessageEntry[] {
  const input = (span.input as { prompts?: unknown } | null)?.prompts;
  const inputEntries: MessageEntry[] = [];
  if (Array.isArray(input)) {
    for (const group of input) {
      if (typeof group === "string") inputEntries.push(...parsePromptGroup(group));
    }
  }
  let lastHumanIdx = -1;
  for (let i = inputEntries.length - 1; i >= 0; i--) {
    if (inputEntries[i].role === "human") {
      lastHumanIdx = i;
      break;
    }
  }
  const newInputEntries = inputEntries.map((e, i) =>
    i >= lastHumanIdx ? { ...e, isNew: true } : e,
  );
  return [...newInputEntries, ...readOutputMessages(span)];
}

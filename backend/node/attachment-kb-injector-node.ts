import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { randomUUID } from "node:crypto";

import { graph as kbAgentGraph } from "@/backend/kb-agent";
import { findAttachmentByR2Key } from "@/lib/attachments/queries";
import { getObject } from "@/lib/r2/client";

/**
 * Ponytail: v1 attachment-kb-injector (issue #13). Runs as a node before
 * chatModelNode in the chat subgraph. Scans the most recent HumanMessage
 * for PDF file content parts; for each, looks up the attachment by R2
 * key, fetches the bytes, and synchronously invokes the kb_agent
 * subgraph (screenshot → VLM → chunk-embed-store). Replaces the file
 * part with a text content part carrying the per-page markdown.
 *
 * state.messages IS updated (rewritten last HumanMessage), trading off
 * the M1 fix of preserving the file part in state. The user-uploaded
 * attachment is still in the chip metadata (assistant-ui side), so the
 * thread UI keeps showing the chip — only the content part the model
 * sees changes. v2 will rewrite at invoke-time only (M2 transition
 * plan) once KB is no longer the sync-fallback path.
 *
 * Per-user isolation: findAttachmentByR2Key scopes by userId from
 * config.configurable. A cross-user URL returns null → silently dropped
 * (test 3 below).
 *
 * Failure isolation: kb_agent's status=failed is surfaced to the model
 * as a "KB processing failed: <error>" text part so the chat can still
 * proceed without grounding. The original file URL is removed.
 */

type FilePart = {
  type: "file";
  data: string;
  mimeType?: string;
  filename?: string;
};

type InjectorState = {
  messages: BaseMessage[];
};

type InjectorConfig = {
  configurable?: {
    userId?: string;
  };
};

function isFilePart(part: unknown): part is FilePart {
  if (typeof part !== "object" || part === null) return false;
  const p = part as { type?: unknown; data?: unknown };
  return p.type === "file" && typeof p.data === "string";
}

function findLastHumanIndex(messages: BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage) return i;
  }
  return -1;
}

function r2KeyFromPublicUrl(publicUrl: string, publicBaseUrl: string): string {
  // ponytail: the R2 public URL is `${baseUrl}/${r2Key}`. Strip the
  // baseUrl prefix to recover the key. Caller falls back to scanning
  // the URL's path components when the baseUrl isn't configured (dev
  // edge case).
  const base = publicBaseUrl.replace(/\/$/, "");
  if (publicUrl.startsWith(base + "/")) {
    return publicUrl.slice(base.length + 1);
  }
  // fallback: assume the publicUrl is "<key>" already
  return publicUrl;
}

function publicBaseUrl(): string {
  // ponytail: read from R2 env. The same env var the r2 client reads.
  // Importing getR2PublicBaseUrl would also assert configured, which
  // we don't want in the no-attachment path. Read directly and fall
  // through to a path-only parse if the env is unset.
  return process.env.R2_PUBLIC_BASE_URL ?? "";
}

export async function attachmentKbInjectorNode(
  state: InjectorState,
  config: InjectorConfig = {},
): Promise<Partial<InjectorState>> {
  if (!state.messages?.length) return {};
  const lastIdx = findLastHumanIndex(state.messages);
  if (lastIdx === -1) return {};
  const last = state.messages[lastIdx];
  if (!Array.isArray(last.content)) return {};

  const userId = config.configurable?.userId;
  if (typeof userId !== "string" || !userId) return {};

  const base = publicBaseUrl();
  // ponytail: HumanMessage's content array type is a complex union of
  // ContentBlock | Text variants that vary by langchain version. We
  // pass through whatever the original message had, and the only new
  // part we add is `{ type: "text", text: string }` — which is in
  // every ContentBlock variant. Type the array as `unknown[]` here
  // and cast at the HumanMessage boundary; the runtime shape is fine
  // and the langchain version pin keeps the type stable.
  const newContent: Array<Record<string, unknown>> = [];
  let replaced = false;

  for (const part of last.content) {
    if (!isFilePart(part)) {
      newContent.push(part as Record<string, unknown>);
      continue;
    }
    if (part.mimeType !== "application/pdf") {
      // v1: PDFs only. Images, docs, etc. pass through untouched.
      newContent.push(part as Record<string, unknown>);
      continue;
    }
    const r2Key = r2KeyFromPublicUrl(part.data, base);
    const attachment = await findAttachmentByR2Key(userId, r2Key);
    if (!attachment) {
      // ponytail: cross-user URL or stale attachment — drop silently
      // (matches the kb_agent + chat mention cross-user 404 rule from
      // docs/AUTH.md). Don't push the part back; the user gets a
      // message with the file silently absent, not a leaked reference.
      continue;
    }
    const pdfBytes = await getObject(attachment.r2Key);
    const result = await kbAgentGraph.invoke({
      userId,
      attachmentId: attachment.id,
      sourceUrl: null,
      title: attachment.name,
      contentType: attachment.contentType,
      contentHash: attachment.sha256 ?? `unknown-${randomUUID()}`,
      pdfBytes,
      docId: `d-${randomUUID()}`,
    });

    if (result.status === "failed") {
      newContent.push({
        type: "text",
        text: `KB processing failed: ${result.errorMessage ?? "unknown error"}`,
      });
    } else {
      const text = (result.pages as Array<{ markdown: string }>)
        .map((p) => p.markdown)
        .filter((m) => m.length > 0)
        .join("\n\n");
      newContent.push({ type: "text", text });
    }
    replaced = true;
  }

  if (!replaced) return {};

  const newMsg = new HumanMessage({ content: newContent as never });
  return {
    messages: [...state.messages.slice(0, lastIdx), newMsg, ...state.messages.slice(lastIdx + 1)],
  };
}

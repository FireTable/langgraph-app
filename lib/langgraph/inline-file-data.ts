// Ponytail: chat attachments are stored on R2 and the adapter embeds
// the public URL into the HumanMessage as `{ type: "file", data: <url> }`.
// The OpenAI Responses API (LangChain ChatOpenAI path → Azure) rejects
// `file_data` that's a plain HTTPS URL — it MUST be a base64 data URL of
// the form `data:<mime>;base64,<...>`. We walk the messages right before
// the model invoke, fetch the URL server-side, and swap the data field
// in-place.
//
// Why server-side fetch and not client-side base64: the browser doesn't
// have the file at message-send time on the LangGraph server (only R2
// has it), and the adapter's `data: publicUrl` is the only reference
// the chat runtime has. The server can fetch from R2 with the AWS SDK
// it already has configured; the browser can't.
//
// Size cap: openai Responses API doesn't document a hard cap on
// `file_data` length, but PDFs over a few MB blow past most model
// context windows even with the 1:1.33 base64 inflation. We cap at
// 2 MiB; larger files get a text marker so the LLM at least knows the
// filename and URL exists. A future iteration can use the OpenAI Files
// API (`file_id` reference) for large files — out of scope here.

import type { BaseMessage, MessageContent } from "@langchain/core/messages";

type FilePart = {
  type: "file";
  data: string;
  mime_type?: string;
  mimeType?: string;
  metadata?: { filename?: string };
  [k: string]: unknown;
};

type TextPart = { type: "text"; text: string };
type ContentPart = TextPart | FilePart;

const MAX_INLINE_BYTES = 2 * 1024 * 1024;

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//.test(s);
}

function isDataUrl(s: string): boolean {
  return /^data:[\w/+-]+;base64,/.test(s);
}

function mimeOf(part: FilePart): string {
  return (part.mime_type ?? part.mimeType ?? "application/octet-stream") as string;
}

function filenameOf(part: FilePart): string | undefined {
  return part.metadata?.filename;
}

function filePartMarker(part: FilePart): string {
  const name = filenameOf(part);
  return `[file too large to inline: ${name ?? mimeOf(part)}] (${part.data})`;
}

async function inlineOne(part: FilePart, signal: AbortSignal): Promise<FilePart | string> {
  if (!part.data || !isHttpUrl(part.data)) return part; // already data: or empty
  const res = await fetch(part.data, { signal });
  if (!res.ok) {
    return filePartMarker({ ...part, data: `[fetch ${res.status}]` });
  }
  const contentLength = Number(res.headers.get("content-length") ?? "0");
  if (contentLength > MAX_INLINE_BYTES) return filePartMarker(part);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_INLINE_BYTES) return filePartMarker(part);
  const b64 = Buffer.from(buf).toString("base64");
  return {
    ...part,
    data: `data:${mimeOf(part)};base64,${b64}`,
  };
}

async function inlineContentPart(
  part: ContentPart,
  signal: AbortSignal,
): Promise<ContentPart | string> {
  if (part.type !== "file") return part;
  const filePart = part as FilePart;
  if (isDataUrl(filePart.data ?? "")) return part;
  return inlineOne(filePart, signal);
}

function markerPart(text: string): TextPart {
  return { type: "text", text };
}

export async function inlineFileData(
  messages: BaseMessage[],
  options: { signal?: AbortSignal } = {},
): Promise<BaseMessage[]> {
  const signal = options.signal ?? new AbortController().signal;
  return Promise.all(
    messages.map(async (m) => {
      const content = m.content as MessageContent;
      if (typeof content === "string") return m;
      if (!Array.isArray(content)) return m;
      const out: ContentPart[] = [];
      let mutated = false;
      for (const part of content as Array<ContentPart | string>) {
        if (typeof part === "string") {
          // String elements in multimodal content are not standard
          // (ContentBlock is object-only). Wrap as text part so the
          // output is always a ContentBlock[].
          out.push(markerPart(part));
          mutated = true;
          continue;
        }
        const inlined = await inlineContentPart(part, signal);
        if (typeof inlined === "string") {
          out.push(markerPart(inlined));
          mutated = true;
        } else {
          out.push(inlined);
          if (inlined !== part) mutated = true;
        }
      }
      if (!mutated) return m;
      const Ctor = Object.getPrototypeOf(m).constructor as new (fields: {
        content: MessageContent;
        id?: string;
        name?: string;
        additional_kwargs?: Record<string, unknown>;
        response_metadata?: Record<string, unknown>;
      }) => BaseMessage;
      return new Ctor({
        // Cast: ContentPart is a subset of ContentBlock structurally;
        // LangChain's strict union is satisfied by every variant we emit.
        content: out as unknown as MessageContent,
        ...(m.id ? { id: m.id } : {}),
        ...(m.name ? { name: m.name } : {}),
        additional_kwargs: m.additional_kwargs ?? {},
        response_metadata: m.response_metadata ?? {},
      });
    }),
  );
}

import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";

import { db } from "@/db/client";
import { kbChunk, kbDocument, kbFolder } from "@/lib/kb/schema";
import { resolveKbMentions, KB_FALLBACK_TOOL_CALL_ID } from "@/lib/kb/resolve-mentions";
import { _resetKbEnvCache } from "@/lib/kb/env";
import { TEST_USER, ensureTestUser, makeUser } from "@/tests/helpers/auth";

// ponytail: resolver tests run against the real DB. The resolver
// ONLY emits a ToolMessage for the 0-chunk @doc fallback — every
// other case (chunks > 0, folder, parsing/failed, unknown) is
// dropped silently and the LLM handles it via search_kb.

const FOLDER_ID = `f-${randomUUID()}`;
const DOC_A_ID = `d-${randomUUID()}`;

function makeEmbedding(seed: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 1024; i++) out.push(Math.sin(seed + i * 0.01) * 0.001);
  return out;
}

async function seedSuccessDocWithChunks(docId: string) {
  await db.insert(kbDocument).values({
    id: docId,
    userId: TEST_USER.id,
    folderId: FOLDER_ID,
    title: `doc-${docId.slice(0, 6)}.pdf`,
    contentType: "application/pdf",
    contentHash: `hash-${docId}`,
    status: "success",
  });
  await db.insert(kbChunk).values({
    id: `c-${randomUUID()}`,
    documentId: docId,
    ordinal: 0,
    content: "Acme was founded in 2020.",
    embedding: makeEmbedding(1),
    entities: [{ name: "Acme", type: "Organization", description: "desc" }],
  } as never);
}

async function seedSuccessDocNoChunks(docId: string) {
  // 0-chunk case — chunking pass hasn't landed any rows yet. The doc
  // has OCR'd pages so the resolver can fall back to full markdown.
  await db.insert(kbDocument).values({
    id: docId,
    userId: TEST_USER.id,
    folderId: FOLDER_ID,
    title: `nochunks-${docId.slice(0, 6)}.pdf`,
    contentType: "application/pdf",
    contentHash: `hash-${docId}`,
    status: "success",
    pages: [
      { pageNumber: 1, markdown: "Page one content" },
      { pageNumber: 2, markdown: "Page two content" },
    ],
  } as never);
}

// ponytail: locate the fallback ToolMessage (if any) by tool_call_id.
function findKbToolMessage(messages: ReturnType<typeof Array.prototype.slice>) {
  return messages.find(
    (m: { constructor: { name: string }; tool_call_id?: string }) =>
      m.constructor.name === "ToolMessage" && m.tool_call_id === KB_FALLBACK_TOOL_CALL_ID,
  ) as ToolMessage | undefined;
}

beforeEach(async () => {
  _resetKbEnvCache();
  await ensureTestUser();
  await db.delete(kbChunk);
  await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
  await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
  await db.insert(kbFolder).values({ id: FOLDER_ID, userId: TEST_USER.id, name: "Attachments" });
});

afterEach(async () => {
  await db.delete(kbChunk);
  await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
  await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
});

describe("lib/kb/resolve-mentions", () => {
  it("returns messages unchanged when no mentions are present", async () => {
    const messages = [new HumanMessage({ content: "plain user text", id: "m-1" })];
    const out = await resolveKbMentions(messages, TEST_USER.id);
    expect(findKbToolMessage(out)).toBeUndefined();
    expect((out[0] as HumanMessage).content).toBe("plain user text");
    expect(out).toHaveLength(1);
  });

  it("returns messages unchanged when userId is missing (safety belt)", async () => {
    const messages = [new HumanMessage({ content: `see :kb-document[${DOC_A_ID}]`, id: "m-1" })];
    const out = await resolveKbMentions(messages, undefined);
    expect(findKbToolMessage(out)).toBeUndefined();
    expect((out[0] as HumanMessage).content).toMatch(/:kb-document\[/);
  });

  it("does NOT inject a ToolMessage for a @doc with chunks (LLM handles it via search_kb)", async () => {
    await seedSuccessDocWithChunks(DOC_A_ID);
    const messages = [
      new HumanMessage({ content: `please summarize :kb-document[${DOC_A_ID}]`, id: "m-1" }),
    ];
    const out = await resolveKbMentions(messages, TEST_USER.id);
    // ponytail: the resolver used to inject a fake "meta" ToolMessage
    // for the @doc-with-chunks case. That was dishonest (the query
    // was fake, the chunks were placeholders) and forced the LLM to
    // call search_kb a second time. Now the directive is preserved
    // in the HumanMessage text and the LLM calls search_kb itself.
    expect(findKbToolMessage(out)).toBeUndefined();
    expect(out).toHaveLength(1);
    expect((out[0] as HumanMessage).content).toMatch(/:kb-document\[/);
  });

  it("injects a fallback ToolMessage for a @doc with 0 chunks (full page markdown)", async () => {
    await seedSuccessDocNoChunks(DOC_A_ID);
    const messages = [
      new HumanMessage({ content: `please summarize :kb-document[${DOC_A_ID}]`, id: "m-1" }),
    ];
    const out = await resolveKbMentions(messages, TEST_USER.id);
    // Length grew by exactly 2 (AIMessage + ToolMessage pair — LLM
    // providers validate the synthetic tool_call_id pairing).
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(messages[0]);
    const tm = findKbToolMessage(out);
    expect(tm).toBeInstanceOf(ToolMessage);
    expect(tm!.name).toBe("search_kb");
    const payload = JSON.parse(String(tm!.content));
    expect(payload.empty).toBe(false);
    expect(payload.documents).toHaveLength(1);
    expect(payload.documents[0].legsHit).toEqual(["full"]);
    expect(payload.documents[0].content).toMatch(/Page one content/);
    expect(payload.documents[0].content).toMatch(/Page two content/);
  });

  it("does NOT inject a ToolMessage for a @doc in 'parsing' status (LLM handles it)", async () => {
    await db.insert(kbDocument).values({
      id: DOC_A_ID,
      userId: TEST_USER.id,
      folderId: FOLDER_ID,
      title: "parsing-doc.pdf",
      contentType: "application/pdf",
      contentHash: `hash-parsing-${randomUUID()}`,
      status: "parsing",
    });
    const messages = [
      new HumanMessage({ content: `@mention :kb-document[${DOC_A_ID}]`, id: "m-1" }),
    ];
    const out = await resolveKbMentions(messages, TEST_USER.id);
    // ponytail: the resolver used to emit a soft-warning ToolMessage
    // for parsing/failed docs. The user now sees the status in the
    // Settings -> KB UI; the chat resolver stays out of the way so
    // the LLM just acknowledges the mention and moves on.
    expect(findKbToolMessage(out)).toBeUndefined();
  });

  it("drops cross-user mentions silently (no ToolMessage)", async () => {
    const other = await makeUser();
    await db.insert(kbFolder).values({
      id: `f-${randomUUID()}`,
      userId: other.id,
      name: "Attachments",
    });
    const otherFolderId = (await db.query.kbFolder.findFirst({
      where: eq(kbFolder.userId, other.id),
    }))!.id;
    await db.insert(kbDocument).values({
      id: DOC_A_ID,
      userId: other.id,
      folderId: otherFolderId,
      title: "other.pdf",
      contentType: "application/pdf",
      contentHash: `hash-other-${randomUUID()}`,
      status: "success",
    });

    const messages = [new HumanMessage({ content: `:kb-document[${DOC_A_ID}]`, id: "m-1" })];
    const out = await resolveKbMentions(messages, TEST_USER.id);
    expect(findKbToolMessage(out)).toBeUndefined();

    await db.delete(kbDocument).where(eq(kbDocument.id, DOC_A_ID));
    await db.delete(kbFolder).where(eq(kbFolder.userId, other.id));
  });

  it("drops unknown doc ids silently (no ToolMessage)", async () => {
    const messages = [new HumanMessage({ content: `:kb-document[d-nonexistent-xyz]`, id: "m-1" })];
    const out = await resolveKbMentions(messages, TEST_USER.id);
    expect(findKbToolMessage(out)).toBeUndefined();
  });

  it("preserves the original directive text in the HumanMessage (does not strip)", async () => {
    await seedSuccessDocNoChunks(DOC_A_ID);
    const messages = [
      new HumanMessage({ content: `please summarize :kb-document[${DOC_A_ID}]`, id: "m-1" }),
    ];
    const out = await resolveKbMentions(messages, TEST_USER.id);
    expect((out[0] as HumanMessage).content).toMatch(/:kb-document\[/);
    expect(findKbToolMessage(out)).toBeDefined();
  });

  it("handles multi-part HumanMessage content arrays", async () => {
    await seedSuccessDocNoChunks(DOC_A_ID);
    const messages = [
      new HumanMessage({
        content: [{ type: "text", text: ":kb-document[" + DOC_A_ID + "]" }] as never,
        id: "m-1",
      }),
    ];
    const out = await resolveKbMentions(messages, TEST_USER.id);
    expect(findKbToolMessage(out)).toBeDefined();
  });

  it("resolves a mention using the short :kb-doc format by title", async () => {
    await seedSuccessDocNoChunks(DOC_A_ID);
    const title = `nochunks-${DOC_A_ID.slice(0, 6)}.pdf`;
    const messages = [
      new HumanMessage({ content: `please summarize :kb-doc[${title}]`, id: "m-1" }),
    ];
    const out = await resolveKbMentions(messages, TEST_USER.id);
    const tm = findKbToolMessage(out);
    expect(tm).toBeDefined();
    const payload = JSON.parse(String(tm!.content));
    expect(payload.documents[0].docTitle).toBe(title);
  });

  it("does not insert a second kb-fallback pair if one already exists in messages", async () => {
    await seedSuccessDocNoChunks(DOC_A_ID);
    const first = await resolveKbMentions(
      [new HumanMessage({ content: `:kb-document[${DOC_A_ID}]`, id: "m-1" })],
      TEST_USER.id,
    );
    expect(findKbToolMessage(first)).toBeDefined();
    // Second call: same mention, but the previous ToolMessage is
    // still in `messages`. We must NOT add another.
    const second = await resolveKbMentions(
      [...first, new HumanMessage({ content: `follow up :kb-document[${DOC_A_ID}]`, id: "m-2" })],
      TEST_USER.id,
    );
    const tms = second.filter(
      (m): m is ToolMessage =>
        m instanceof ToolMessage && m.tool_call_id === KB_FALLBACK_TOOL_CALL_ID,
    );
    expect(tms).toHaveLength(1);
    expect(second[second.length - 1]).toBeInstanceOf(HumanMessage);
    expect((second[second.length - 1] as HumanMessage).id).toBe("m-2");
  });
});

import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";

import { db } from "@/db/client";
import { kbChunk, kbDocument, kbFolder } from "@/lib/kb/schema";
import { resolveKbMentions } from "@/lib/kb/resolve-mentions";
import { _resetKbEnvCache } from "@/lib/kb/env";
import { TEST_USER, ensureTestUser, makeUser } from "@/tests/helpers/auth";

// ponytail: resolver tests run against the real DB. Seed a doc + chunk
// pair, then verify the resolver parses directives, fetches chunks, and
// emits a ToolMessage into the messages stream.

const FOLDER_ID = `f-${randomUUID()}`;
const DOC_A_ID = `d-${randomUUID()}`;

function makeEmbedding(seed: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 1024; i++) out.push(Math.sin(seed + i * 0.01) * 0.001);
  return out;
}

async function seedSuccessDoc(docId: string) {
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

// ponytail: helper — find the ToolMessage in a messages array (if any).
function findKbToolMessage(messages: ReturnType<typeof Array.prototype.slice>) {
  return messages.find(
    (m: { constructor: { name: string }; tool_call_id?: string }) =>
      m.constructor.name === "ToolMessage" && m.tool_call_id === "kb-context",
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
    // Original directive text is NOT stripped (per current design).
    expect((out[0] as HumanMessage).content).toMatch(/:kb-document\[/);
  });

  it("inserts a ToolMessage after the last HumanMessage when a mention resolves", async () => {
    await seedSuccessDoc(DOC_A_ID);
    const messages = [
      new HumanMessage({ content: `please summarize :kb-document[${DOC_A_ID}]`, id: "m-1" }),
    ];
    const out = await resolveKbMentions(messages, TEST_USER.id);

    // Length grew by exactly 2 (AIMessage + ToolMessage pair — LLM
    // providers validate the synthetic tool_call_id pairing, so the
    // AIMessage wrapper is required alongside the ToolMessage).
    expect(out).toHaveLength(3);
    // Original HumanMessage preserved at its position.
    expect(out[0]).toBe(messages[0]);
    // ToolMessage inserted right after the HumanMessage.
    const tm = findKbToolMessage(out);
    expect(tm).toBeInstanceOf(ToolMessage);
    expect(tm!.name).toBe("search_kb");
    // ponytail: payload is the same shape search_kb returns, so the
    // existing KbSearchToolUI card can render it. `content` carries
    // the LLM-facing markdown; `documents` is the structured chunks.
    const payload = JSON.parse(String(tm!.content));
    expect(payload.empty).toBe(false);
    expect(payload.content).toMatch(/<mentioned-documents>/);
    expect(payload.content).toMatch(/doc-/);
    expect(Array.isArray(payload.documents)).toBe(true);
    expect(payload.documents.length).toBeGreaterThan(0);
  });

  it("inserts a ToolMessage with a soft-warning when the doc is in 'parsing' status (no resolved chunks)", async () => {
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
    // ponytail: soft-warning IS still surfaced via ToolMessage so the
    // LLM can tell the user the doc is being ingested. Empty documents
    // array, but the warning text is in the content.
    const tm = findKbToolMessage(out);
    expect(tm).toBeDefined();
    const payload = JSON.parse(String(tm!.content));
    expect(payload.empty).toBe(false);
    expect(payload.documents).toEqual([]);
    expect(payload.content).toMatch(/still ingesting/);
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

    // cleanup
    await db.delete(kbDocument).where(eq(kbDocument.id, DOC_A_ID));
    await db.delete(kbFolder).where(eq(kbFolder.userId, other.id));
  });

  it("drops unknown doc ids silently (no ToolMessage)", async () => {
    const messages = [new HumanMessage({ content: `:kb-document[d-nonexistent-xyz]`, id: "m-1" })];
    const out = await resolveKbMentions(messages, TEST_USER.id);
    expect(findKbToolMessage(out)).toBeUndefined();
  });

  it("preserves the original directive text in the HumanMessage (does not strip)", async () => {
    await seedSuccessDoc(DOC_A_ID);
    const messages = [
      new HumanMessage({ content: `please summarize :kb-document[${DOC_A_ID}]`, id: "m-1" }),
    ];
    const out = await resolveKbMentions(messages, TEST_USER.id);
    // Directive token preserved on the original HumanMessage.
    expect((out[0] as HumanMessage).content).toMatch(/:kb-document\[/);
    // ToolMessage inserted (we did resolve the doc).
    expect(findKbToolMessage(out)).toBeDefined();
  });

  it("handles multi-part HumanMessage content arrays", async () => {
    await seedSuccessDoc(DOC_A_ID);
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
    await seedSuccessDoc(DOC_A_ID);
    const title = `doc-${DOC_A_ID.slice(0, 6)}.pdf`;
    const messages = [
      new HumanMessage({ content: `please summarize :kb-doc[${title}]`, id: "m-1" }),
    ];
    const out = await resolveKbMentions(messages, TEST_USER.id);
    const tm = findKbToolMessage(out);
    expect(tm).toBeDefined();
    const payload = JSON.parse(String(tm!.content));
    expect(payload.documents[0].docTitle).toBe(title);
  });

  it("does not insert a second kb-context pair if one already exists in messages", async () => {
    // ponytail: state.messages persists across turns (LangGraph
    // messages reducer appends). When the same thread runs prepareData
    // again — e.g. next turn, the previous kb-context pair is still
    // in scope. Re-inserting with the same tool_call_id would be a
    // duplicate the LLM provider rejects, so we skip.
    await seedSuccessDoc(DOC_A_ID);
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
      (m): m is ToolMessage => m instanceof ToolMessage && m.tool_call_id === "kb-context",
    );
    // Exactly ONE ToolMessage with kb-context across both calls.
    expect(tms).toHaveLength(1);
    // Second HumanMessage is preserved at the tail.
    expect(second[second.length - 1]).toBeInstanceOf(HumanMessage);
    expect((second[second.length - 1] as HumanMessage).id).toBe("m-2");
  });
});

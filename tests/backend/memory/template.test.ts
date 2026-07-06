import { describe, it, expect } from "vitest";
import { SystemMessage } from "@langchain/core/messages";
import { createSystemPromptWithMemoryTemplate } from "@/backend/memory/template";

describe("createSystemPromptWithMemoryTemplate", () => {
  it("returns a SystemMessage with the base prompt when memory is null", async () => {
    const msg = await createSystemPromptWithMemoryTemplate("You are helpful.", null, null);
    expect(msg).toBeInstanceOf(SystemMessage);
    expect(msg.content).toBe("You are helpful.");
  });

  it("appends a <memory> block when memory is provided", async () => {
    const payload = { memory: { role: "backend" } };
    const msg = await createSystemPromptWithMemoryTemplate("You are helpful.", payload, null);
    const text = String(msg.content);
    expect(text).toContain("You are helpful.");
    expect(text).toContain("<memory>");
    expect(text).toContain("backend");
    expect(text).toContain("</memory>");
  });

  it("appends a <threads> block when thread summaries are provided", async () => {
    const threads = {
      threadId: "t1",
      summaries: [
        {
          sequence: 1,
          summary: { entries: [{ question: "hello", answer: "world", refs: ["#1"] }] },
          startMessageIndex: 0,
          endMessageIndex: 9,
          triggerReason: "turn_based" as const,
          tokenCountBefore: 80,
          tokenCountAfter: 12,
          createdAt: "2026-07-06T00:00:00.000Z",
        },
      ],
    };
    const msg = await createSystemPromptWithMemoryTemplate("base", null, threads);
    const text = String(msg.content);
    expect(text).toContain("<thread>");
    expect(text).toContain("</thread>");
    expect(text).toContain("hello");
    expect(text).toContain("EARLIER CONVERSATION");
  });

  it("does NOT render a <threads> block when summaries is empty / null", async () => {
    const msg = await createSystemPromptWithMemoryTemplate("base", null, null);
    const text = String(msg.content);
    expect(text).not.toContain("<thread>");
  });

  it("does not include a <memory> block when memory is null", async () => {
    const msg = await createSystemPromptWithMemoryTemplate("You are helpful.", null, null);
    expect(String(msg.content)).not.toContain("<memory>");
  });

  it("omits both blocks when memory is empty", async () => {
    return createSystemPromptWithMemoryTemplate(
      "base",
      { memory: {} },
      { threadId: "t1", summaries: [] },
    ).then((msg) => {
      expect(String(msg.content)).not.toContain("<memory>");
      expect(String(msg.content)).not.toContain("<threads>");
    });
  });

  it("preserves base prompt verbatim including newlines and special chars", async () => {
    const base = "Line 1\nLine 2 — with em-dash & ampersand";
    const msg = await createSystemPromptWithMemoryTemplate(base, null, null);
    expect(String(msg.content)).toBe(base);
  });

  it("serializes memory as pretty-printed JSON for readability", async () => {
    const payload = { memory: { a: 1, b: 2 } };
    const msg = await createSystemPromptWithMemoryTemplate("base", payload, null);
    const text = String(msg.content);
    expect(text).toContain('"a": 1');
    expect(text).toContain('"b": 2');
  });

  it("renders <save_memory_rule> inside <memory> when memory is present", async () => {
    const payload = { memory: { role: "backend" } };
    const msg = await createSystemPromptWithMemoryTemplate("base", payload, null);
    const text = String(msg.content);
    expect(text).toContain("<save_memory_rule>");
    expect(text).toContain("</save_memory_rule>");
    const memoryOpen = text.indexOf("<memory>");
    const ruleOpen = text.indexOf("<save_memory_rule>");
    const memoryClose = text.indexOf("</memory>");
    expect(memoryOpen).toBeGreaterThan(-1);
    expect(ruleOpen).toBeGreaterThan(memoryOpen);
    expect(memoryClose).toBeGreaterThan(ruleOpen);
  });

  it("wraps {{memoryJson}} in <memory_json> tag inside <memory>", async () => {
    const payload = { memory: { role: "backend" } };
    const msg = await createSystemPromptWithMemoryTemplate("base", payload, null);
    const text = String(msg.content);
    const memoryOpen = text.indexOf("<memory>");
    const tagOpen = text.indexOf("<memory_json>");
    const tagClose = text.indexOf("</memory_json>");
    const ruleOpen = text.indexOf("<save_memory_rule>");
    expect(memoryOpen).toBeGreaterThan(-1);
    expect(tagOpen).toBeGreaterThan(memoryOpen);
    expect(tagClose).toBeGreaterThan(tagOpen);
    expect(ruleOpen).toBeGreaterThan(tagClose);
    expect(text.substring(tagOpen, tagClose)).toContain('"role"');
    expect(text.substring(tagOpen, tagClose)).toContain('"backend"');
  });

  it("omits <save_memory_rule> when memory is null", async () => {
    const msg = await createSystemPromptWithMemoryTemplate("base", null, null);
    expect(String(msg.content)).not.toContain("<save_memory_rule>");
  });

  it("save_memory_rule points at the tool description instead of re-stating rules", async () => {
    const payload = { memory: { role: "backend" } };
    const msg = await createSystemPromptWithMemoryTemplate("base", payload, null);
    const text = String(msg.content);
    expect(text).toMatch(/save_memory tool description/i);
    expect(text).not.toMatch(/DO NOT save ephemeral/i);
    expect(text).not.toMatch(/overwrite with care/i);
  });

  it("omits <save_memory_rule> when payload is empty", async () => {
    const msg = await createSystemPromptWithMemoryTemplate("base", { memory: {} }, null);
    expect(String(msg.content)).not.toContain("<save_memory_rule>");
  });
});

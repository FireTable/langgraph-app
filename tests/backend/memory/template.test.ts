import { describe, it, expect } from "vitest";
import { SystemMessage } from "@langchain/core/messages";
import { createSystemPromptWithMemoryTemplate } from "@/backend/memory/template";

describe("createSystemPromptWithMemoryTemplate", () => {
  it("returns a SystemMessage with the base prompt when memory is null", async () => {
    const msg = await createSystemPromptWithMemoryTemplate("You are helpful.", null);
    expect(msg).toBeInstanceOf(SystemMessage);
    expect(msg.content).toBe("You are helpful.");
  });

  it("appends a <memory> block when memory is provided", async () => {
    const payload = { memory: { role: "backend" } };
    const msg = await createSystemPromptWithMemoryTemplate("You are helpful.", payload);
    const text = String(msg.content);
    expect(text).toContain("You are helpful.");
    expect(text).toContain("<memory>");
    expect(text).toContain("backend");
    expect(text).toContain("</memory>");
  });

  it("does NOT render a <threads> block (cross-thread injection retired)", async () => {
    // ponytail: the cross-thread threadsJson block was removed from the
    // MEMORY_AUGMENTED_PROMPT_TEMPLATE — thread summaries now live inline
    // in the messages channel of each thread. The {{threadsJson}} field
    // is gone from the template, so even if a caller passed one it would
    // be a no-op. The template-level test is the simplest place to pin
    // this invariant so a future copy-paster can't reintroduce the leak.
    const msg = await createSystemPromptWithMemoryTemplate("base", {
      memory: { role: "backend" },
    });
    const text = String(msg.content);
    expect(text).not.toContain("<threads>");
    expect(text).not.toContain("</threads>");
    // ponytail: the template's input variables no longer include
    // threadsJson — passing it is just ignored.
    expect(text).not.toContain("threadsJson");
  });

  it("does not include a <memory> block when memory is null", async () => {
    const msg = await createSystemPromptWithMemoryTemplate("You are helpful.", null);
    expect(String(msg.content)).not.toContain("<memory>");
  });

  it("omits both blocks when memory is empty", () => {
    // ponytail: an empty memory ({}) renders as "{}" — mustache's
    // `{{#var}}` section treats non-empty strings as truthy, so we'd
    // accidentally render empty tags. The template layer short-circuits
    // empty-memory to null so the section is skipped entirely.
    return createSystemPromptWithMemoryTemplate("base", { memory: {} }).then((msg) => {
      expect(String(msg.content)).not.toContain("<memory>");
      expect(String(msg.content)).not.toContain("<threads>");
    });
  });

  it("preserves base prompt verbatim including newlines and special chars", async () => {
    const base = "Line 1\nLine 2 — with em-dash & ampersand";
    const msg = await createSystemPromptWithMemoryTemplate(base, null);
    expect(String(msg.content)).toBe(base);
  });

  it("serializes memory as pretty-printed JSON for readability", async () => {
    const payload = { memory: { a: 1, b: 2 } };
    const msg = await createSystemPromptWithMemoryTemplate("base", payload);
    const text = String(msg.content);
    // pretty-printed = indented, multi-line JSON
    expect(text).toContain('"a": 1');
    expect(text).toContain('"b": 2');
  });

  it("renders <save_memory_rule> inside <memory> when memory is present", async () => {
    const payload = { memory: { role: "backend" } };
    const msg = await createSystemPromptWithMemoryTemplate("base", payload);
    const text = String(msg.content);
    expect(text).toContain("<save_memory_rule>");
    expect(text).toContain("</save_memory_rule>");
    // rule lives inside <memory>, not as a sibling — checked by ordering
    const memoryOpen = text.indexOf("<memory>");
    const ruleOpen = text.indexOf("<save_memory_rule>");
    const memoryClose = text.indexOf("</memory>");
    expect(memoryOpen).toBeGreaterThan(-1);
    expect(ruleOpen).toBeGreaterThan(memoryOpen);
    expect(memoryClose).toBeGreaterThan(ruleOpen);
  });

  it("wraps {{memoryJson}} in <memory_json> tag inside <memory>", async () => {
    const payload = { memory: { role: "backend" } };
    const msg = await createSystemPromptWithMemoryTemplate("base", payload);
    const text = String(msg.content);
    // <memory_json> opens right after <memory>, closes before <save_memory_rule>
    const memoryOpen = text.indexOf("<memory>");
    const tagOpen = text.indexOf("<memory_json>");
    const tagClose = text.indexOf("</memory_json>");
    const ruleOpen = text.indexOf("<save_memory_rule>");
    expect(memoryOpen).toBeGreaterThan(-1);
    expect(tagOpen).toBeGreaterThan(memoryOpen);
    expect(tagClose).toBeGreaterThan(tagOpen);
    expect(ruleOpen).toBeGreaterThan(tagClose);
    // JSON literal sits between the two tags
    expect(text.substring(tagOpen, tagClose)).toContain('"role"');
    expect(text.substring(tagOpen, tagClose)).toContain('"backend"');
  });

  it("omits <save_memory_rule> when memory is null", async () => {
    const msg = await createSystemPromptWithMemoryTemplate("base", null);
    expect(String(msg.content)).not.toContain("<save_memory_rule>");
  });

  it("save_memory_rule points at the tool description instead of re-stating rules", async () => {
    const payload = { memory: { role: "backend" } };
    const msg = await createSystemPromptWithMemoryTemplate("base", payload);
    const text = String(msg.content);
    // ponytail: the system prompt is an index, not a re-statement —
    // model should consult the tool description for the actual rules.
    // Drift between two copies of the same rules was the failure mode
    // this collapsed structure avoids.
    expect(text).toMatch(/save_memory tool description/i);
    // the rule body should NOT re-state the rules anymore
    expect(text).not.toMatch(/DO NOT save ephemeral/i);
    expect(text).not.toMatch(/overwrite with care/i);
  });

  it("omits <save_memory_rule> when payload is empty", async () => {
    // ponytail: empty payload is normalized to null at the template
    // layer, so neither <memory> nor the rule render.
    const msg = await createSystemPromptWithMemoryTemplate("base", { memory: {} });
    expect(String(msg.content)).not.toContain("<save_memory_rule>");
  });
});

import { describe, expect, it } from "vitest";

import { mergeHrOnlyChunks, normalizeLightRagOut } from "@/backend/node/kb/entity-extract-node";

// ponytail: forward-merge orphan HR chunks. officeparser emits `\n---\n`
// between sheets/slides/pages; LangChain's MarkdownTextSplitter treats
// `---` as a paragraph break, so when content is long enough to hit
// `chunkSize` the splitter cuts AT the rule and emits it as its own
// chunk. Embedding `---` alone is meaningless — merge forward.

describe("backend/node/kb/entity-extract-node — mergeHrOnlyChunks", () => {
  it("passes through plain content unchanged", () => {
    expect(mergeHrOnlyChunks(["alpha", "beta"])).toEqual(["alpha", "beta"]);
  });

  it("folds a leading HR into the first content chunk", () => {
    expect(mergeHrOnlyChunks(["---", "alpha"])).toEqual(["---\n\nalpha"]);
  });

  it("folds a mid HR into the next chunk", () => {
    expect(mergeHrOnlyChunks(["alpha", "---", "beta"])).toEqual(["alpha", "---\n\nbeta"]);
  });

  it("folds multiple consecutive HRs into the next non-HR chunk", () => {
    expect(mergeHrOnlyChunks(["alpha", "---", "---", "---", "beta"])).toEqual([
      "alpha",
      "---\n\n---\n\n---\n\nbeta",
    ]);
  });

  it("treats HR with surrounding whitespace as an HR-only chunk", () => {
    expect(mergeHrOnlyChunks(["alpha", "  \n  ---\n  \n", "beta"])).toEqual([
      "alpha",
      "---\n\nbeta",
    ]);
  });

  it("does NOT touch GFM table separator rows (which have leading pipes)", () => {
    // `| --- | --- |` is a markdown table separator, not a horizontal
    // rule. Its trim() is `| --- | --- |`, not `---` — must survive.
    const table = "| --- | --- |\n| a | b |";
    expect(mergeHrOnlyChunks(["alpha", table, "beta"])).toEqual(["alpha", table, "beta"]);
  });

  it("does NOT touch Setext H2 (text on the line BEFORE ---)", () => {
    // `Title\n---` is a markdown H2 heading. The chunk text is the
    // whole thing, not just `---`. Must survive untouched.
    const heading = "Some Title\n---";
    expect(mergeHrOnlyChunks(["alpha", heading, "beta"])).toEqual(["alpha", heading, "beta"]);
  });

  it("drops a trailing HR-only chunk (no successor to merge into)", () => {
    expect(mergeHrOnlyChunks(["alpha", "beta", "---"])).toEqual(["alpha", "beta"]);
  });

  it("returns an empty array when every chunk is HR-only", () => {
    expect(mergeHrOnlyChunks(["---", "---", "---"])).toEqual([]);
  });

  it("returns an empty array for empty input", () => {
    expect(mergeHrOnlyChunks([])).toEqual([]);
  });

  it("preserves the order of non-HR chunks", () => {
    const out = mergeHrOnlyChunks(["a", "---", "b", "---", "c"]);
    expect(out.map((s) => s.split("\n").pop())).toEqual(["a", "b", "c"]);
  });
});

// ponytail: top-level per-chunk themes. The prompt emits themes once
// at the schema top level (high-level macro topics for the chunk);
// we fan them out to every entity/relationship in the same chunk
// so kb_entity.themes and kb_relationship.themes both get populated.

describe("backend/node/kb/entity-extract-node — normalizeLightRagOut (themes)", () => {
  it("fans chunk-level themes out to every entity", () => {
    const out = normalizeLightRagOut({
      entities: [
        { name: "Acme", type: "Organization", description: "d" },
        { name: "Beta", type: "Organization", description: "d" },
      ],
      relationships: [],
      themes: ["Tech", "Growth"],
    });
    expect(out.entities[0]!.themes).toEqual(["Tech", "Growth"]);
    expect(out.entities[1]!.themes).toEqual(["Tech", "Growth"]);
  });

  it("fans chunk-level themes out to every relationship", () => {
    const out = normalizeLightRagOut({
      entities: [{ name: "Acme", type: "Organization", description: "d" }],
      relationships: [{ source: "Acme", target: "Beta", relation: "PARTNERED", description: "x" }],
      themes: ["Funding"],
    });
    expect(out.relationships[0]!.themes).toEqual(["Funding"]);
  });

  it("trims and dedupes top-level themes", () => {
    const out = normalizeLightRagOut({
      entities: [{ name: "Acme", type: "Organization", description: "d" }],
      relationships: [],
      themes: ["  Tech  ", "Tech", "Growth", "", "  "],
    });
    expect(out.entities[0]!.themes).toEqual(["Tech", "Growth"]);
  });

  it("defaults to [] when themes missing", () => {
    const out = normalizeLightRagOut({
      entities: [{ name: "Acme", type: "Organization", description: "d" }],
      relationships: [],
    });
    expect(out.entities[0]!.themes).toEqual([]);
  });

  it("merges themes across two entities that collapse to the same canonical", () => {
    // Two LLM-emitted entities with the same lower(name+type) merge
    // by description; themes are union-deduped across the merged rows.
    const out = normalizeLightRagOut({
      entities: [
        { name: "Acme", type: "Organization", description: "first" },
        { name: "acme", type: "organization", description: "second" },
      ],
      relationships: [],
      themes: ["Tech", "Growth"],
    });
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]!.themes.sort()).toEqual(["Growth", "Tech"]);
  });

  it("merges themes across two relations that collapse to the same canonical", () => {
    const out = normalizeLightRagOut({
      entities: [],
      relationships: [
        { source: "Acme", target: "Beta", relation: "PARTNERED", description: "x" },
        { source: "acme", target: "beta", relation: "partnered", description: "y" },
      ],
      themes: ["Funding"],
    });
    expect(out.relationships).toHaveLength(1);
    expect(out.relationships[0]!.themes).toEqual(["Funding"]);
  });
});

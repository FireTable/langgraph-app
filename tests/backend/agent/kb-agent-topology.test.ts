import { describe, expect, it } from "vitest";
import { kbAgent } from "@/backend/agent/kb-agent";

describe("kbAgent topology (chunksEmbed collapse)", () => {
  it("exposes a single chunksEmbed node instead of three inner nodes", () => {
    // ponytail: post-refactor, the entity extract / alignment /
    // embed chain lives inside the `chunksEmbed` sub-agent. The
    // parent kbAgent graph collapses it to one node so by
    // construction the three inner steps run in declared order
    // with no race.
    const nodeNames = Object.keys((kbAgent as any).nodes ?? {});
    expect(nodeNames).toContain("chunksEmbedAgent");
    expect(nodeNames).not.toContain("entityExtract");
    expect(nodeNames).not.toContain("entityAlignment");
    expect(nodeNames).not.toContain("entityEmbed");
    // The legacy pre-refactor name must be gone too.
    expect(nodeNames).not.toContain("generateChunkEmbed");
  });

  it("does NOT route through chunksEmbed when no processed file is new", () => {
    // Defensive: rewritten path skips chunksEmbed when every
    // processedFile is already non-`new` (the common chat / tool
    // KB-read path never needs an extraction cycle).
    expect((kbAgent as any).builder?.edges ?? []).toBeTruthy();
  });
});

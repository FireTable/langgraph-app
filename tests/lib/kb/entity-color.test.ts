// ponytail: TDD coverage for `entityColor` — graphRAG-native
// entity/node coloring. Pure function, no React/DOM deps.
//
// Design:
//   hue      ← FNV-1a hash of sorted-neighbors signature (same
//               neighbor set = same hue, regardless of node.type)
//   sat/light ← degree-driven (high-degree hubs = saturated + dark,
//               isolated nodes = muted)
//   empty    ← no neighbors → muted slate fallback (any type, no data)

import { describe, expect, it } from "vitest";
import { entityColor } from "@/lib/kb/entityColor";

describe("entityColor", () => {
  it("returns the same color for the same name on repeated calls", () => {
    const a = entityColor("AWS", ["S3", "EC2"], 3);
    const b = entityColor("AWS", ["S3", "EC2"], 3);
    expect(a).toEqual(b);
  });

  it("returns the same hue for different names that share an identical neighbor set", () => {
    // ponytail: this is the whole point — neighbor signature
    // (sorted) drives hue. Two entities in the same structural role
    // (same neighbors) get the same color, regardless of their name
    // or LLM-given type.
    const a = entityColor("Lambda", ["S3", "EC2"], 2);
    const b = entityColor("GlueJob", ["S3", "EC2"], 2);
    expect(a.h).toBe(b.h);
    expect(a.s).toBe(b.s);
  });

  it("is neighbor-order insensitive (sorted signature)", () => {
    const a = entityColor("X", ["B", "A", "C"], 1);
    const b = entityColor("X", ["C", "A", "B"], 1);
    expect(a.h).toBe(b.h);
  });

  it("produces a different hue when the neighbor set differs", () => {
    const a = entityColor("AWS", ["S3", "EC2"], 3);
    const b = entityColor("AWS", ["Lambda", "DynamoDB"], 3);
    expect(a.h).not.toBe(b.h);
  });

  it("drives saturation UP with degree (hubs are more saturated)", () => {
    const isolated = entityColor("X", [], 1);
    const hub = entityColor("X", ["A", "B", "C", "D"], 8);
    expect(hub.s).toBeGreaterThan(isolated.s);
  });

  it("drives lightness DOWN with degree (hubs are darker)", () => {
    const isolated = entityColor("X", [], 1);
    const hub = entityColor("X", ["A", "B", "C", "D"], 8);
    expect(hub.l).toBeLessThan(isolated.l);
  });

  it("clamps degree saturation/lightness so super-hubs stay readable", () => {
    // degree 50 should still produce a valid color, not pure black
    const superHub = entityColor("X", ["A", "B", "C"], 50);
    expect(superHub.s).toBeLessThanOrEqual(95);
    expect(superHub.l).toBeGreaterThanOrEqual(25);
  });

  it("returns muted fallback when there are no neighbors (isolated entity)", () => {
    const c = entityColor("orphan", [], 0);
    // No hue-driven data → muted slate; s is low, l is high.
    expect(c.s).toBeLessThan(20);
    expect(c.l).toBeGreaterThan(70);
  });

  it("emits valid hsl(h, s%, l%) components", () => {
    const c = entityColor("AWS", ["S3", "EC2"], 5);
    expect(c.h).toBeGreaterThanOrEqual(0);
    expect(c.h).toBeLessThan(360);
    expect(c.s).toBeGreaterThanOrEqual(0);
    expect(c.s).toBeLessThanOrEqual(100);
    expect(c.l).toBeGreaterThanOrEqual(0);
    expect(c.l).toBeLessThanOrEqual(100);
  });

  it("returns a tailwind-friendly bg/fg/border triplet", () => {
    const c = entityColor("AWS", ["S3", "EC2"], 5);
    expect(c.bg).toMatch(/^hsl\(/);
    expect(c.fg).toMatch(/^hsl\(/);
    expect(c.border).toMatch(/^hsl\(/);
  });

  it("desaturates bg and border so the result reads as 'tinted grey' not pure hue", () => {
    // ponytail: design contract — all three colors share the same
    // hue, but bg/border are pulled down in saturation so the result
    // feels muted (slate-50 canvas) instead of "primary colors". fg
    // keeps more chroma because it carries readable text.
    const c = entityColor("AWS", ["S3", "EC2"], 5);
    const bgSat = Number(c.bg.match(/hsl\(\d+, (\d+)%/)?.[1] ?? 0);
    const borderSat = Number(c.border.match(/hsl\(\d+, (\d+)%/)?.[1] ?? 0);
    const fgSat = Number(c.fg.match(/hsl\(\d+, (\d+)%/)?.[1] ?? 0);
    expect(bgSat).toBeLessThan(c.s); // bg dimmed from base sat
    expect(borderSat).toBeLessThan(c.s); // border dimmed too
    expect(fgSat).toBeGreaterThanOrEqual(bgSat); // fg is the most chroma
  });
});

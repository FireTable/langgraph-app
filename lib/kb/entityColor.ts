// ponytail: graphRAG-native entity/node coloring. Pure function —
// no React, no DOM, no DB. Used by:
//   - knowledge-graph.tsx  (canvas node fill, hover tooltip badge,
//     uniqueEntities list badge)
//   - doc-detail-dialog.tsx (chunk-level entity badge)
//
// Why this exists: the previous color scheme was a string whitelist
// (`e.type === "person" → blue`, `"organization" → amber`, `"concept"
// → green`, everything else → grey). LLM extraction produces ~40
// distinct type strings per doc (IoT Platform, AI Coding Tool,
// 硬件设备, Profile, ...). All but 1-3 fall into the grey bucket.
//
// New scheme:
//   hue      ← FNV-1a hash of sorted-neighbors signature. Same
//               neighbor set = same hue, regardless of name or
//               LLM-given type. Visually answers "these two
//               entities live in the same neighborhood of the
//               graph".
//   sat      ← degree-driven (low = muted, high = saturated). Hubs
//               stand out without needing a separate color legend.
//   light    ← degree-driven (low = light, high = dark). Adds a
//               second visual cue so colorblind users still see
//               hub-ness from saturation alone.
//   empty    ← no neighbors → muted slate fallback. No hue to
//               derive; signal is "this entity isn't connected yet".

export type EntityColor = {
  h: number;
  s: number;
  l: number;
  bg: string;
  fg: string;
  border: string;
};

// ponytail: clamp helper. Keep these readable — too saturated looks
// neon, too dark loses contrast against the slate-50 graph background.
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// FNV-1a 32-bit on a string → integer in [0, 2^32). Stable across
// calls (no Date.now / Math.random) so the same entity gets the
// same color across re-renders.
function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ponytail: hsl() with consistent separators — Tailwind classes
// can't express dynamic hue, so we emit raw CSS strings. Consumers
// pass them to `style={{ background: c.bg }}` (canvas) or
// `className` with `style={{ ... }}` override (DOM badges).
const hsl = (h: number, s: number, l: number) => `hsl(${h}, ${s}%, ${l}%)`;

export function entityColor(
  _name: string,
  neighbors: readonly string[],
  degree: number,
): EntityColor {
  // Empty neighbor set → muted slate, no hue. Same fallback for any
  // type/degree combo — it's the structural "isolated" signal.
  if (neighbors.length === 0) {
    return {
      h: 215,
      s: 12,
      l: 78,
      bg: hsl(215, 12, 92),
      fg: hsl(215, 12, 35),
      border: hsl(215, 12, 65),
    };
  }

  // Sort neighbors so the signature is order-stable. An entity that
  // links to {A, B, C} hashes the same regardless of the order its
  // edges were stored in.
  const sig = [...neighbors].sort().join("|");
  const hue = fnv1a(sig) % 360;

  // ponytail: saturation pulled WAY down after the first visual pass —
  // 50% baseline + +5%/degree was lighting up the whole graph like
  // a Christmas tree. 30% baseline + +4%/degree keeps hubs
  // distinguishable from leaves without each node competing for
  // attention against the slate background.
  const sat = clamp(30 + Math.min(degree * 4, 40), 30, 70);

  // Degree → lightness: 68% baseline (light enough to read on slate
  // background), -3%/degree, floor at 35%. Darker hubs read as
  // "more important" without crossing into unreadable.
  const light = clamp(68 - Math.min(degree * 3, 33), 35, 68);

  // ponytail: "monochrome with a hint of hue" — bg/fg/border all
  // carry a slate-grey undertone so the result feels high-end
  // instead of "primary colors shouting". Strategy: pull bg/border
  // saturation way down (closer to grey), let fg keep a bit more
  // chroma so text is still readable.
  return {
    h: hue,
    s: sat,
    l: light,
    // bg: very desaturated, light. Reads as "tinted grey" not "saturated
    // color".
    bg: hsl(hue, Math.round(sat * 0.5), clamp(light + 32, 80, 96)),
    // fg: keep some chroma so text doesn't disappear into the slate
    // background. Used only for badge text (nodes don't paint fg).
    fg: hsl(hue, clamp(sat + 5, 0, 100), clamp(light - 18, 22, 80)),
    // border: desaturated, mid-tone. Reads as "tinted stroke" so the
    // node is visible without screaming.
    border: hsl(hue, Math.round(sat * 0.6), clamp(light - 4, 35, 70)),
  };
}

# Landing page

Marketing surface at `/`. Server-rendered by the `(landing)` route
group (`app/(landing)/`), with `landing-motion-provider` as the only
client island so the page never blocks first paint on the motion
bundle.

## Sections

| Section        | File                                    | Notes                                                                                                                                                                                                                                                                       |
| -------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header         | `components/landing/header.tsx`         | Sticky, blurred. Server reads the session and threads `signedIn` to `HeroCta` (the same component the hero uses, so copy stays in sync). GitHub glyph is an inline SVG — the pinned `lucide-react@1.23.0` doesn't export a `Github` icon.                                   |
| Hero           | `components/landing/hero.tsx`           | Gradient h1 (`from-rose-500 via-amber-500 to-amber-300`) with a blurred halo span that shares the same 6s drift animation. Streaming preview is a client island.                                                                                                            |
| Features       | `components/landing/features.tsx`       | 4-card bento (`big` headliner + `wide` Memory + two `default`) over a 3-card row (Composable / HITL / Self-host). Hue palette in `HUE` carries both the icon-chip class and the card-level tint, so each card wears its own colour, not just a dot.                         |
| Knowledge base | `components/landing/knowledge-base.tsx` | Dedicated KB section between Features and How-it-works. Heading + a two-column row (server-rendered copy on the left, scroll-driven `KbPipelineDemo` client island on the right). Anchors the pipeline + hybrid-search + reprocess-mode copy from `docs/KNOWLEDGE_BASE.md`. |
| How it works   | `components/landing/how-it-works.tsx`   | Five scroll-driven explainers. Each motion demo is a separate client island; the surrounding copy is server-rendered so it's in the initial HTML.                                                                                                                           |
| Self-host      | `components/landing/self-host.tsx`      | `QuickStartTabs` swap between Agent (paste into Claude Code / Cursor) and Command (bash quick-start).                                                                                                                                                                       |
| CTA            | `components/landing/cta.tsx`            | "Read the code. Run it. Skip the demo." Card lives on top of a warm halo (`--glow-warm` / `--glow-bright`) that rotates via `cta-marquee` — same palette as the interrupt-glow ring so the two affordances share a hue family.                                              |
| Footer         | `components/landing/footer.tsx`         | Three columns + brand blurb. No CTA button — the sticky header and the CTA section above already carry "Chat now" / "Sign in".                                                                                                                                              |

## Assets

- `app/opengraph-image.tsx` — 1200×630 OG image rendered with `next/og` ImageResponse. Title, subtitle, and the same warm-halo palette as the hero h1.
- `app/robots.ts` — generated robots, allow-all root, points to `/sitemap.xml`.
- `app/sitemap.ts` — generated sitemap, single entry at `/`.

## Motion + animations

All bespoke keyframes live in `app/globals.css`:

| Keyframe                                  | Owner                    | Purpose                                                                                      |
| ----------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| `tool-call-marquee` + `tool-call-breathe` | tool-call interrupt card | Conic ring rotation + opacity breathe on `data-slot$="-card"` inside `.tool-call-glow-host`. |
| `cta-marquee`                             | CTA section halo         | Same conic-from-`--cta-angle` trick so the warm halo rotates instead of standing still.      |
| `hero-text-flow`                          | hero h1                  | Gradient drifts via `background-position` 0→100% on `alternate`, so colours oscillate.       |
| `aui-pulse`                               | streaming chat caret     | Vendored from assistant-ui's markdown styles so the caret uses `▍` instead of `●`.           |

`prefers-reduced-motion: reduce` halts every animation (conic, text-flow, hero halo, aui-pulse).

## Route group naming

`app/(landing)/` is the **only** route group. `(parens)` keep it out of
the URL (`/` not `/landing/`). If you need to add an admin / app section,
pick a different group name so the public/operator split stays obvious.

## Tests

Frontend tests under `tests/frontend/landing/`:

- `sections.test.tsx` — pins the four feature headings + Knowledge-base heading + How-it-works row copy. Refactors that drop a title or rewrite it ambiguously fail here.
- `hero-cta.test.tsx` — auth-aware copy variants.
- `header.test.tsx` — nav links + sticky chrome.

Run with `pnpm test --run` (the frontend jsdom env is configured in `tests/frontend/setup.ts`).

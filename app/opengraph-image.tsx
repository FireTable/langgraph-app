import { ImageResponse } from "next/og";

import { APP_NAME } from "@/lib/constants";

export const alt = `${APP_NAME} — streaming chat backed by a LangGraph StateGraph`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// ponytail: dynamic OG image. Renders a 1200x630 card with the
// project name, one-line pitch, and a minimal status line. Colors
// are plain hex/rgb because Satori (the renderer under next/og) does
// NOT support oklch() — using it crashes the route with an empty
// response.

const TAGLINE = "A chat surface for a real agent graph.";

export default async function Image() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        background: "linear-gradient(135deg, #1a1d2b 0%, #0e0f15 100%)",
        color: "#fafafa",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: 6,
            background: "#f5d76e",
          }}
        />
        <div
          style={{
            fontSize: 22,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            color: "#8b8fa3",
          }}
        >
          {APP_NAME}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div
          style={{
            fontSize: 76,
            lineHeight: 1.05,
            fontWeight: 600,
            letterSpacing: -1.5,
            maxWidth: 980,
          }}
        >
          {TAGLINE}
        </div>
        <div
          style={{
            fontSize: 26,
            lineHeight: 1.4,
            color: "#8b8fa3",
            maxWidth: 900,
          }}
        >
          Streaming chat · Dual-graph background work · Memory · Observability waterfall
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 20,
          color: "#8b8fa3",
        }}
      >
        <span>Self-hostable · Open source</span>
        <span>github.com/FireTable/langgraph-app</span>
      </div>
    </div>,
    { ...size },
  );
}

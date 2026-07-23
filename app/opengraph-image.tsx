import { ImageResponse } from "next/og";
import fs from "node:fs";
import path from "node:path";

import { APP_NAME } from "@/lib/constants";

export const alt = `${APP_NAME} — streaming chat backed by a LangGraph StateGraph`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// ponytail: dynamic OG image. Renders a 1200x630 card with the
// project logo, project name, one-line pitch, and a minimal status line. Colors
// are plain hex/rgb because Satori (the renderer under next/og) does
// NOT support oklch() — using it crashes the route with an empty
// response.

const TAGLINE = "A chat surface for a real agent graph.";

export default async function Image() {
  const logoPath = path.join(process.cwd(), "public/logo.png");
  const logoBuffer = fs.readFileSync(logoPath);
  const logoBase64 = `data:image/png;base64,${logoBuffer.toString("base64")}`;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        background: "linear-gradient(135deg, #181b28 0%, #0c0d13 100%)",
        color: "#fafafa",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Background Watermark Logo: Bottom Right, ~80% canvas height (500px), fading out via opacity */}
      <div
        style={{
          position: "absolute",
          right: -110,
          bottom: -140,
          width: 500,
          height: 500,
          display: "flex",
          opacity: 0.28,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoBase64} width="500" height="500" style={{ objectFit: "contain" }} alt="" />
      </div>

      {/* Gradient mask layer: top-left to bottom-right gradient fade overlay */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background:
            "linear-gradient(135deg, #181b28 35%, rgba(24, 27, 40, 0.6) 65%, transparent 100%)",
          display: "flex",
        }}
      />

      {/* Foreground Content */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 36,
          position: "relative",
          zIndex: 10,
        }}
      >
        <div
          style={{
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: 0.4,
            color: "#ffffff",
          }}
        >
          {APP_NAME}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              fontSize: 48,
              lineHeight: 1.05,
              fontWeight: 600,
              letterSpacing: -1.5,
              maxWidth: 880,
              color: "#ffffff",
            }}
          >
            {TAGLINE}
          </div>
          <div
            style={{
              fontSize: 26,
              lineHeight: 1.4,
              color: "#9da2b4",
              maxWidth: 840,
            }}
          >
            Streaming chat · Dual-graph background work · Memory · Observability waterfall
          </div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 20,
          color: "#8b8fa3",
          position: "relative",
          zIndex: 10,
        }}
      >
        <span>Self-hostable · Open source</span>
        <span>github.com/FireTable/langgraph-app</span>
      </div>
    </div>,
    { ...size },
  );
}

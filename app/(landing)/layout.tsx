import type { Metadata } from "next";
import type { FC, ReactNode } from "react";

import { APP_NAME } from "@/lib/constants";
import { LandingMotionProvider } from "@/components/landing/landing-motion-provider";

const TITLE = `${APP_NAME} — streaming chat backed by a LangGraph StateGraph`;
const DESCRIPTION =
  "Self-hostable chat surface for a real LangGraph agent. Streaming chat, dual-graph background work, cross-conversation memory, observability waterfall, and composable tools.";
const SITE_URL = process.env.SITE_URL ?? "https://ai.firetable.tech";
const OG_IMAGE = `${SITE_URL}/opengraph-image`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: `%s · ${APP_NAME}`,
  },
  description: DESCRIPTION,
  applicationName: APP_NAME,
  keywords: [
    "LangGraph",
    "LangGraph.js",
    "self-hosted",
    "chat agent",
    "AI agent",
    "streaming chat",
    "observability",
    "OpenAI",
  ],
  authors: [{ name: "FireTable" }],
  creator: "FireTable",
  publisher: "FireTable",
  alternates: {
    canonical: "/",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  openGraph: {
    title: APP_NAME,
    description: DESCRIPTION,
    type: "website",
    siteName: APP_NAME,
    url: SITE_URL,
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: APP_NAME }],
  },
  twitter: {
    card: "summary_large_image",
    title: APP_NAME,
    description: DESCRIPTION,
    images: [OG_IMAGE],
  },
};

// ponytail: JSON-LD SoftwareApplication schema. Sits in the route
// group layout so every marketing page inherits it. The two URLs
// point at the live app and the repo so crawlers can attach them
// to the entity.

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: APP_NAME,
  description: DESCRIPTION,
  url: SITE_URL,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Any",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  author: { "@type": "Organization", name: "FireTable" },
  license: "https://opensource.org/licenses/MIT",
  codeRepository: "https://github.com/FireTable/langgraph-app",
};

// ponytail: route-group layout. The marketing subtree is public and
// gets its own metadata; the actual session check happens in
// `app/(marketing)/page.tsx` (the page decides header / hero CTA copy).
const MarketingLayout: FC<{ children: ReactNode }> = ({ children }) => (
  <LandingMotionProvider>
    <script
      type="application/ld+json"
      // JSON.stringify is safe here — the object is a literal under
      // our control, no user input.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
    />
    {children}
  </LandingMotionProvider>
);

export default MarketingLayout;

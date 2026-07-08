import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://ai.firetable.tech";

// ponytail: allow everything on the marketing site, block /chat and
// /settings (both are auth-gated; crawlers have no business hitting
// them and they bloat crawl budgets). Reference the sitemap so
// well-behaved crawlers can find it.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/chat", "/settings", "/api/", "/login"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}

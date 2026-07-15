import { BookOpen } from "lucide-react";

import { KbView } from "@/components/settings/kb-view";

// ponytail: KB settings plugin. Mirrors memory-tab.tsx — same shape
// (id + viewPaths + settingsTabs) so BetterAuthUIProvider renders the
// tab alongside Memory + Credit.
export const kbSettingsPlugin = {
  id: "knowledge-base",
  viewPaths: { settings: { "knowledge-base": "knowledge-base" } },
  settingsTabs: [
    {
      view: "knowledge-base",
      label: (
        <>
          <BookOpen className="text-muted-foreground" aria-hidden />
          {/* ponytail: text is auto-hidden on mobile by the global
              rule in app/globals.css ([role="tab"] > span:not(.sr-only))
              using the sr-only technique. Above md the rule doesn't
              apply and the text shows inline. */}
          <span>Knowledge Base</span>
        </>
      ),
      component: KbView,
    },
  ],
};

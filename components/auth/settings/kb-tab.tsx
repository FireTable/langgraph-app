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
          Knowledge Base
        </>
      ),
      component: KbView,
    },
  ],
};

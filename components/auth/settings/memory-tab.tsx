import { Brain } from "lucide-react";

import { MemoryView } from "@/components/settings/memory-view";

// ponytail: one plugin object owns the Memory settings tab. AuthProvider
// forwards every entry in `plugins` to useAuth(), and <Settings> reads
// `plugin.settingsTabs` to render TabsTrigger + TabsContent. Label is a
// ReactNode so we can prefix the lucide icon the way other tabs do
// (see components/auth/settings/settings.tsx: `<User2 ... />`).
export const memorySettingsPlugin = {
  id: "memory",
  viewPaths: { settings: { memory: "memory" } },
  settingsTabs: [
    {
      view: "memory",
      label: (
        <>
          <Brain className="text-muted-foreground" aria-hidden />
          {/* ponytail: text is auto-hidden on mobile by the global
              rule in app/globals.css ([role="tab"] > span:not(.sr-only))
              using the sr-only technique. Above md the rule doesn't
              apply and the text shows inline. */}
          <span>Memory</span>
        </>
      ),
      component: MemoryView,
    },
  ],
};

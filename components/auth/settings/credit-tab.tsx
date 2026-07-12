import { Receipt } from "lucide-react";

import { CreditHistory } from "@/components/settings/credit-history";

// ponytail: mirrors memory-tab.tsx — same plugin shape so the Settings
// shell renders it as another TabsTrigger + TabsContent. Credit history
// is a per-user read-only view of their own credit_usage_log rows, so
// it lives under the user-facing settings page (not the admin panel).
export const creditSettingsPlugin = {
  id: "credit",
  viewPaths: { settings: { credit: "credit" } },
  settingsTabs: [
    {
      view: "credit",
      label: (
        <>
          <Receipt className="text-muted-foreground" aria-hidden />
          Credits
        </>
      ),
      component: CreditHistory,
    },
  ],
};

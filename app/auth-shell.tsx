"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthProvider as BetterAuthUIProvider } from "@/components/auth/auth-provider";
import { authClient } from "@/lib/auth/client";
import { memorySettingsPlugin } from "@/components/auth/settings/memory-tab";

export function AuthShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <BetterAuthUIProvider
      authClient={authClient}
      basePaths={{ auth: "/login", settings: "/settings" }}
      socialProviders={["github", "google"]}
      multipleAccountsPerProvider={false}
      plugins={[memorySettingsPlugin]}
      emailAndPassword={{
        minPasswordLength: 8,
        confirmPassword: true,
        requireEmailVerification: true,
      }}
      redirectTo="/chat"
      Link={Link}
      navigate={({ to, replace }) => (replace ? router.replace(to) : router.push(to))}
    >
      {children}
    </BetterAuthUIProvider>
  );
}

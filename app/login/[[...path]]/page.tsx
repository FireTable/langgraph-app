"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Auth } from "@/components/auth/auth";
import { authClient } from "@/lib/auth/client";

export default function LoginPage() {
  const router = useRouter();
  const params = useParams<{ path?: string[] }>();
  const { data: session } = authClient.useSession();

  useEffect(() => {
    if (session) router.replace("/chat");
  }, [session, router]);

  const segment = params.path?.[0];
  return (
    <div className="bg-muted/30 flex min-h-dvh items-center justify-center p-4">
      <Auth view={segment ? undefined : "signIn"} path={segment ?? "sign-in"} />
    </div>
  );
}

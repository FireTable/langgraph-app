"use client";

import { CircleCheckIcon, MessagesSquareIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldDescription } from "@/components/ui/field";

const REDIRECT_SECONDS = 5;

export function VerifiedView({ hasSession }: { hasSession: boolean }) {
  const router = useRouter();
  const [remaining, setRemaining] = useState(REDIRECT_SECONDS);

  // lib/auth/config.ts sets autoSignInAfterVerification: true, so a fresh
  // verification lands here with a real session → CTA → /chat.
  // hasSession=false is the rare case: direct bookmark/refresh visits,
  // where there's no verification flow in flight and the user still needs
  // to sign in.
  const target = hasSession ? "/chat" : "/login";

  useEffect(() => {
    if (remaining <= 0) {
      router.replace(target);
      return;
    }
    const t = setTimeout(() => setRemaining((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining, router, target]);

  return (
    <div className="bg-muted/30 flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="flex flex-col items-center gap-3 text-center">
          <CircleCheckIcon className="size-10 text-green-600" aria-hidden />
          <CardTitle className="text-xl font-semibold">Email verified</CardTitle>
        </CardHeader>

        <CardContent>
          <div className="flex flex-col gap-3">
            <FieldDescription className="text-center">
              Your email is confirmed. {hasSession ? "You're signed in." : "You can now sign in."}
            </FieldDescription>

            <FieldDescription className="text-center" aria-live="polite">
              {remaining > 0 ? `Redirecting in ${remaining}s…` : "Redirecting…"}
            </FieldDescription>

            <Button asChild size="lg" className="w-full mt-2">
              <Link href={target} replace>
                <MessagesSquareIcon />
                Chat Now
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

"use client";

import { CircleCheckIcon, MessagesSquareIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldDescription } from "@/components/ui/field";

const REDIRECT_SECONDS = 5;

// The server page at app/login/verified/page.tsx redirects to /login
// whenever there's no session, so by the time this component renders the
// user is verified and signed in. No `hasSession` prop needed — the page
// is the gate.
export function VerifiedView() {
  const router = useRouter();
  const [remaining, setRemaining] = useState(REDIRECT_SECONDS);

  useEffect(() => {
    if (remaining <= 0) {
      router.replace("/chat");
      return;
    }
    const t = setTimeout(() => setRemaining((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining, router]);

  return (
    <div className="bg-muted/30 flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="flex flex-col items-center gap-3 text-center">
          <CircleCheckIcon className="size-10 text-green-600" aria-hidden />
          <CardTitle className="text-xl font-semibold">Email verified</CardTitle>
        </CardHeader>

        <CardContent>
          <div className="flex flex-col gap-4">
            <FieldDescription className="text-center">
              Your email is confirmed. You're signed in.
            </FieldDescription>

            <FieldDescription className="text-center" aria-live="polite">
              {remaining > 0 ? `Redirecting in ${remaining}s…` : "Redirecting…"}
            </FieldDescription>

            <Button asChild size="lg" className="w-full">
              <Link href="/chat" replace>
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

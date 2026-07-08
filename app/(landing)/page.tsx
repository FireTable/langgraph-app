import type { FC } from "react";

import { getSessionFromHeaders } from "@/lib/auth/queries";
import { Header } from "@/components/landing/header";
import { Hero } from "@/components/landing/hero";
import { Features } from "@/components/landing/features";
import { HowItWorks } from "@/components/landing/how-it-works";
import { SelfHost } from "@/components/landing/self-host";
import { Cta } from "@/components/landing/cta";
import { Footer } from "@/components/landing/footer";

// ponytail: server component reads the session once, threads a
// boolean through to header + hero + footer. The other sections
// are identical for signed-in and signed-out visitors — the
// marketing surface doesn't gate on auth (rule #9: no withAuth on
// `/`).

const MarketingHome: FC = async () => {
  const session = await getSessionFromHeaders();
  const signedIn: boolean | null = session ? true : session === null ? false : null;

  return (
    <>
      <Header signedIn={signedIn} />
      <main className="bg-background text-foreground min-h-dvh">
        <Hero signedIn={signedIn} />
        <Features />
        <HowItWorks />
        <SelfHost />
        <Cta signedIn={signedIn} />
        <Footer />
      </main>
    </>
  );
};

export default MarketingHome;

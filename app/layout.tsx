import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AuthShell } from "@/app/auth-shell";
import { Web3Providers } from "@/app/web3-providers";
import { APP_NAME } from "@/lib/constants";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: `${APP_NAME} — streaming chat backed by a LangGraph StateGraph agent`,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {/* ponytail: client-visible env surfaced to the browser as
            window.__CONFIG__ (lib/window-config.d.ts). `beforeInteractive`
            hoists into <head> and runs synchronously before the bundle
            parses, so wagmi/RainbowKit (lib/wagmi.ts) sees the config at
            module-init time. JSON.stringify guards against quoting issues
            in env values; undefined fields are dropped. */}
        <Script id="bootstrap-config" strategy="beforeInteractive">
          {`window.__CONFIG__=${JSON.stringify({
            LANGGRAPH_ASSISTANT_ID: process.env.LANGGRAPH_ASSISTANT_ID,
            LANGGRAPH_PUBLIC_URL: process.env.LANGGRAPH_PUBLIC_URL,
            WALLET_CONNECT_PROJECT_ID: process.env.WALLET_CONNECT_PROJECT_ID,
            R2_ALLOWED_CONTENT_TYPES: process.env.R2_ALLOWED_CONTENT_TYPES,
            ATTACHMENTS_ENABLED: process.env.ATTACHMENTS_ENABLED,
          })};`}
        </Script>
        <AuthShell>
          <Web3Providers>
            <TooltipProvider>{children}</TooltipProvider>
          </Web3Providers>
        </AuthShell>
        <Toaster />
      </body>
    </html>
  );
}

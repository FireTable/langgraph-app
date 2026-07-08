"use client";

// ponytail: Tabs chrome only. Server `SelfHost` renders the
// Agent and Command content (the parts that need node:fs) and
// passes them as children, so this client component never imports
// the `server-only` module directly.

import type { ReactNode } from "react";
import { SparklesIcon, TerminalIcon } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const QuickStartTabs = ({ agent, command }: { agent: ReactNode; command: ReactNode }) => (
  <Tabs defaultValue="agent" className="gap-3">
    <TabsList className="w-full justify-start">
      <TabsTrigger value="agent">
        <SparklesIcon className="size-3.5" />
        Agent
      </TabsTrigger>
      <TabsTrigger value="command">
        <TerminalIcon className="size-3.5" />
        Command
      </TabsTrigger>
    </TabsList>
    <TabsContent value="agent" className="mt-0">
      {agent}
    </TabsContent>
    <TabsContent value="command" className="mt-0">
      {command}
    </TabsContent>
  </Tabs>
);

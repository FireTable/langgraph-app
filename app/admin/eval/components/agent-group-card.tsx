"use client";

import React, { ReactNode } from "react";
import { ChevronDown, LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface AgentGroupCardProps {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  headerActions?: ReactNode;
  children: ReactNode;
}

export function AgentGroupCard({
  id,
  label,
  description,
  icon: Icon,
  isCollapsed = false,
  onToggleCollapse,
  headerActions,
  children,
}: AgentGroupCardProps) {
  return (
    <Card className="overflow-hidden border-border/80 py-0 gap-0 shadow-2xs">
      <CardHeader className="p-6 border-b border-border/60">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Icon className="size-4 text-primary shrink-0" />
              <CardTitle className="text-base font-semibold">{label}</CardTitle>
              <Badge variant="outline" className="font-mono text-[10px]">
                {id}
              </Badge>
            </div>
            <CardDescription className="text-xs text-muted-foreground">
              {description}
            </CardDescription>
          </div>

          <div className="flex items-center gap-1.5">
            {headerActions}
            {onToggleCollapse && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onToggleCollapse}
                className="gap-1.5"
              >
                <span>{isCollapsed ? "Expand" : "Collapse"}</span>
                <ChevronDown
                  className={`size-3.5 transition-transform duration-200 ${
                    isCollapsed ? "-rotate-90" : "rotate-0"
                  }`}
                />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <div
        className={`grid transition-all duration-300 ease-in-out ${
          isCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
        }`}
      >
        <div className="overflow-hidden">
          <CardContent className="p-6">{children}</CardContent>
        </div>
      </div>
    </Card>
  );
}

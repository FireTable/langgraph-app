"use client";

import React from "react";
import { Network, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserAssignment, Variant } from "../types";

interface UserAssignmentsTabProps {
  assignments: UserAssignment[];
  variants: Variant[];
  userSearch: string;
  onSearchChange: (search: string) => void;
  onOverrideCohort: (userId: string, cohortLabel: string) => void;
  overridingUserId?: string | null;
}

function getInitials(name?: string, email?: string): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0].slice(0, 2).toUpperCase();
  }
  if (email && email.trim()) {
    return email.trim().slice(0, 2).toUpperCase();
  }
  return "US";
}

export function UserAssignmentsTab({
  assignments,
  variants,
  userSearch,
  onSearchChange,
  onOverrideCohort,
  overridingUserId,
}: UserAssignmentsTabProps) {
  // Extract all unique Cohort Labels from available variants
  const availableCohorts = Array.from(new Set(variants.map((v) => v.label)));
  if (!availableCohorts.includes("default")) {
    availableCohorts.unshift("default");
  }

  // Group assignments by userId
  const userMap = new Map<
    string,
    {
      userId: string;
      userName?: string;
      userEmail?: string;
      userImage?: string | null;
      assignedAt: string;
      cohortLabel: string;
      items: UserAssignment[];
    }
  >();

  for (const a of assignments) {
    const existing = userMap.get(a.userId) || {
      userId: a.userId,
      userName: a.userName,
      userEmail: a.userEmail,
      userImage: a.userImage,
      assignedAt: a.assignedAt,
      cohortLabel: a.variantLabel || "default",
      items: [],
    };
    existing.items.push(a);
    if (a.variantLabel && a.variantLabel !== "default") {
      existing.cohortLabel = a.variantLabel;
    }
    userMap.set(a.userId, existing);
  }

  const userList = Array.from(userMap.values()).filter(
    (u) =>
      !userSearch ||
      (u.userEmail && u.userEmail.toLowerCase().includes(userSearch.toLowerCase())) ||
      (u.userName && u.userName.toLowerCase().includes(userSearch.toLowerCase())) ||
      (u.userId && u.userId.toLowerCase().includes(userSearch.toLowerCase())),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">User Experiment Variant Assignments</h3>
          <p className="text-muted-foreground text-xs mt-0.5">
            Inspect or override sticky experiment variant assignments for registered users across all agent nodes.
          </p>
        </div>
        <div className="relative w-full sm:w-[260px]">
          <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
          <Input
            value={userSearch}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search user or email..."
            className="pl-8 h-9 text-xs"
          />
        </div>
      </div>

      <div className="border-border/80 overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs">
        <Table className="text-xs">
          <TableHeader className="bg-muted/50 uppercase text-[10px]">
            <TableRow>
              <TableHead>User Profile</TableHead>
              <TableHead>Routing Mechanism</TableHead>
              <TableHead>Bound Graph Nodes</TableHead>
              <TableHead>Assigned Variant</TableHead>
              <TableHead className="text-right">Assigned Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {userList.map((u) => {
              const isUpdating = overridingUserId === u.userId;
              const isOverride = u.cohortLabel.toLowerCase() !== "default";

              return (
                <TableRow key={u.userId}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar className="size-8 rounded-full bg-muted shrink-0">
                        {u.userImage ? (
                          <AvatarImage src={u.userImage} alt={u.userName || u.userEmail} />
                        ) : null}
                        <AvatarFallback className="text-xs text-muted-foreground font-medium">
                          {(u.userName || u.userEmail || u.userId).slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex flex-col min-w-0">
                        <span className="font-medium text-foreground">{u.userName || "Registered User"}</span>
                        <span className="font-mono text-[11px] text-muted-foreground truncate">
                          {u.userEmail || u.userId}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={isOverride ? "secondary" : "outline"}
                      className="font-mono text-[10px] px-2 py-0.5 gap-1"
                    >
                      {isOverride ? (
                        <>
                          <ShieldCheck className="size-3 text-amber-500" />
                          <span>Admin Override</span>
                        </>
                      ) : (
                        <>
                          <Network className="size-3 text-muted-foreground" />
                          <span>Deterministic Hashed</span>
                        </>
                      )}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-[10px] px-2 py-0.5">
                      10 Agent Nodes
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Select
                        value={u.cohortLabel}
                        onValueChange={(val) => onOverrideCohort(u.userId, val)}
                        disabled={isUpdating}
                      >
                        <SelectTrigger size="sm" className="!h-6 !py-0 w-auto px-2 gap-1.5 text-[10px] font-mono border border-border/80 bg-background hover:bg-muted/50 rounded-md shadow-2xs focus:ring-1 focus:ring-primary">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-foreground uppercase tracking-wide text-[10px]">
                              <SelectValue />
                            </span>
                            <span className="h-2.5 w-px bg-border/80 shrink-0" />
                          </div>
                        </SelectTrigger>
                        <SelectContent position="popper" align="start" className="w-[140px] uppercase">
                          {availableCohorts.map((cohortLabel) => (
                            <SelectItem
                              key={cohortLabel}
                              value={cohortLabel}
                              className="text-xs font-mono uppercase"
                            >
                              {cohortLabel}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {isUpdating && (
                        <RefreshCw className="size-3.5 animate-spin text-primary shrink-0" />
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {new Date(u.assignedAt).toLocaleDateString("en-CA")}
                  </TableCell>
                </TableRow>
              );
            })}
            {userList.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground px-4 py-8 text-center text-xs">
                  No sticky user assignments recorded yet. Invoking agents will automatically assign users to cohorts.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

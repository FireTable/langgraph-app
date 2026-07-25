"use client";

import React from "react";
import { RefreshCw, Search, Sparkles, UserCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Variant, UserAssignment } from "../types";

interface UserAssignmentsTabProps {
  assignments: UserAssignment[];
  variants: Variant[];
  userSearch: string;
  onSearchChange: (search: string) => void;
  onOverrideCohort: (userId: string, cohortLabel: string) => void;
  overridingUserId?: string | null;
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
          <h3 className="text-base font-semibold flex items-center gap-2">
            <UserCheck className="size-4 text-primary" /> User Experiment Variant Assignments
          </h3>
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
              <TableHead>Active Assigned Variant</TableHead>
              <TableHead>Override Variant Assignment</TableHead>
              <TableHead className="text-right">Assigned Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {userList.map((u) => {
              const isUpdating = overridingUserId === u.userId;

              return (
                <TableRow key={u.userId}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium text-foreground">{u.userName || "User"}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {u.userEmail || u.userId}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="default" className="font-mono text-[11px] px-2 py-0.5">
                      <Sparkles className="size-3 mr-1" /> {u.cohortLabel}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2 max-w-[200px]">
                      <Select
                        value={u.cohortLabel}
                        onValueChange={(val) => onOverrideCohort(u.userId, val)}
                        disabled={isUpdating}
                      >
                        <SelectTrigger className="h-8 text-xs font-mono">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {availableCohorts.map((cohortLabel) => (
                            <SelectItem
                              key={cohortLabel}
                              value={cohortLabel}
                              className="text-xs font-mono"
                            >
                              {cohortLabel}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {isUpdating && <RefreshCw className="size-3.5 animate-spin text-primary shrink-0" />}
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
                <TableCell colSpan={4} className="text-muted-foreground px-4 py-8 text-center text-xs">
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

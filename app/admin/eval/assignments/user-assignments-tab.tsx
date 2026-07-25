"use client";

import React from "react";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { UserAssignment } from "../types";

interface UserAssignmentsTabProps {
  assignments: UserAssignment[];
  userSearch: string;
  onSearchChange: (search: string) => void;
}

export function UserAssignmentsTab({
  assignments,
  userSearch,
  onSearchChange,
}: UserAssignmentsTabProps) {
  const filteredAssignments = assignments.filter(
    (a) =>
      !userSearch ||
      (a.userEmail && a.userEmail.toLowerCase().includes(userSearch.toLowerCase())) ||
      (a.userId && a.userId.toLowerCase().includes(userSearch.toLowerCase())) ||
      (a.agent && a.agent.toLowerCase().includes(userSearch.toLowerCase())),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">User Sticky A/B Assignments</h3>
          <p className="text-muted-foreground text-xs mt-0.5">
            Inspect which sticky prompt variant is assigned to each registered user.
          </p>
        </div>
        <div className="relative w-[260px]">
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
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/50 border-b text-muted-foreground font-medium uppercase text-[10px]">
            <tr>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Target Agent</th>
              <th className="px-4 py-3">Assigned Variant</th>
              <th className="px-4 py-3">Template ID</th>
              <th className="px-4 py-3 text-right">Assigned Date</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredAssignments.map((a, idx) => (
              <tr
                key={`${a.userId}-${a.variantId}-${idx}`}
                className="hover:bg-muted/20 transition-colors"
              >
                <td className="px-4 py-3">
                  <div className="flex flex-col">
                    <span className="font-medium text-foreground">{a.userName || "User"}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {a.userEmail || a.userId}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-foreground font-medium">
                  {a.agent || "—"}
                </td>
                <td className="px-4 py-3">
                  <Badge variant="default" className="font-mono text-[11px]">
                    {a.variantLabel || a.variantId}
                  </Badge>
                </td>
                <td className="px-4 py-3 font-mono text-muted-foreground">
                  {a.templateId || "—"}
                </td>
                <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                  {new Date(a.assignedAt).toLocaleDateString("en-CA")}
                </td>
              </tr>
            ))}
            {filteredAssignments.length === 0 && (
              <tr>
                <td colSpan={5} className="text-muted-foreground px-4 py-8 text-center text-xs">
                  No sticky user assignments recorded yet. Invocations will automatically bind
                  users to weighted variants.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

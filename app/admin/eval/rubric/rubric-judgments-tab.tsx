"use client";

import React from "react";
import { Bot, Scale, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Judgment, Rubric } from "../types";

interface RubricJudgmentsTabProps {
  rubrics: Rubric[];
  judgments: Judgment[];
}

export function RubricJudgmentsTab({ rubrics, judgments }: RubricJudgmentsTabProps) {
  return (
    <div className="flex flex-col gap-6">
      {/* Criteria Cards Section */}
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-base font-semibold flex items-center gap-2">
            <Scale className="size-4 text-primary" /> Active Evaluation Rubrics
          </h3>
          <p className="text-muted-foreground text-xs mt-0.5">
            Configured criteria and weights used by the LLM-as-a-Judge agent to evaluate model
            responses.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {rubrics.map((r) => (
            <Card key={r.id} className="border-border/80 shadow-2xs">
              <CardHeader className="p-4 pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Sparkles className="size-3.5 text-primary" /> {r.name}
                </CardTitle>
                <CardDescription className="text-xs font-mono">{r.id}</CardDescription>
              </CardHeader>
              <CardContent className="p-4 pt-0 flex flex-col gap-2">
                <div className="flex flex-col gap-1.5 border-t pt-2">
                  {r.criteria.map((c) => (
                    <div
                      key={c.name}
                      className="flex items-center justify-between text-xs bg-muted/30 p-2 rounded-md"
                    >
                      <div className="flex flex-col">
                        <span className="font-semibold text-foreground">{c.name}</span>
                        <span className="text-[11px] text-muted-foreground">{c.description}</span>
                      </div>
                      <Badge variant="outline" className="font-mono text-[10px] ml-2 shrink-0">
                        Weight {c.weight}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Judgment Scoring Log History */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold flex items-center gap-2">
              <Bot className="size-4 text-primary" /> LLM-as-a-Judge History Log
            </h3>
            <p className="text-muted-foreground text-xs mt-0.5">
              Historical evaluation scores, component breakdowns, and LLM reasoning.
            </p>
          </div>
          <Badge variant="secondary" className="font-mono text-xs">
            {judgments.length} Total Judgments
          </Badge>
        </div>

        <div className="border-border/80 overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs">
          <Table className="text-xs">
            <TableHeader className="bg-muted/50 uppercase text-[10px]">
              <TableRow>
                <TableHead>Run ID</TableHead>
                <TableHead>Target Agent</TableHead>
                <TableHead>Rubric ID</TableHead>
                <TableHead className="text-center">Overall Score</TableHead>
                <TableHead>Judge Reasoning Rationale</TableHead>
                <TableHead className="text-right">Evaluated Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {judgments.map((j) => {
                const overall = j.scores.overall ?? 85;
                return (
                  <TableRow key={j.id}>
                    <TableCell className="font-mono text-[11px] font-medium text-foreground">
                      {j.runId}
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">{j.agent || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{j.rubricId}</TableCell>
                    <TableCell className="text-center">
                      <Badge
                        variant={overall >= 80 ? "default" : "destructive"}
                        className="font-mono text-xs"
                      >
                        {overall} / 100
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-[11px] max-w-md truncate">
                      {j.reasoning}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {new Date(j.createdAt).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                );
              })}
              {judgments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground px-4 py-8 text-center text-xs">
                    No AI Judge evaluation history recorded yet. Trigger AI Judge on an execution
                    run to generate scores!
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

"use client";

import React, { useEffect, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Code2,
  Copy,
  Cpu,
  Database,
  GitBranch,
  Layers,
  Plus,
  RefreshCw,
  Scale,
  Search,
  Sliders,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  UserCheck,
  Workflow,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

type Template = {
  id: string;
  group: string;
  agent: string;
  content: string;
  notes?: string;
  createdAt: string;
};

type Variant = {
  id: string;
  templateId: string;
  label: string;
  trafficWeight: number;
  enabled: boolean;
};

type VariantStat = {
  variantId: string;
  label: string;
  totalRuns: number;
  avgTotalMs: number;
  avgRating: number;
};

type RecentRun = {
  id: string;
  agent: string;
  variantId: string;
  label: string;
  totalMs: number;
  status: string;
  createdAt: string;
  userRating?: number;
  threadId?: string;
  parentMessageId?: string;
  inputTokens?: number;
  outputTokens?: number;
};

type UserAssignment = {
  userId: string;
  userName?: string;
  userEmail?: string;
  variantId: string;
  variantLabel?: string;
  templateId?: string;
  agent?: string;
  assignedAt: string;
};

type Rubric = {
  id: string;
  name: string;
  criteria: Array<{ name: string; description: string; weight: number }>;
};

type Judgment = {
  id: string;
  runId: string;
  rubricId: string;
  scores: Record<string, number>;
  reasoning: string;
  totalCostTokens?: number;
  createdAt: string;
  agent?: string;
  variantId?: string;
};

type RunTraceDetail = {
  run: RecentRun;
  feedback?: { rating: number; reason?: string };
  judgment?: Judgment;
  spans?: Array<{ id: string; name: string; durationMs: number; error?: string }>;
};

const LANGGRAPH_GROUPS = [
  {
    id: "agent",
    label: "Main Chat Graph (agent)",
    entrypoint: "./backend/agent.ts",
    icon: Cpu,
    description: "Core interactive chat, intent router, and domain sub-agents",
    agents: [
      {
        id: "chatAgent",
        name: "Chat Agent",
        desc: "General conversational LLM & tool orchestrator",
      },
      { id: "routerAgent", name: "Router Agent", desc: "Intent classification & node dispatcher" },
      { id: "weatherAgent", name: "Weather Sub-Agent", desc: "Geocoding & forecast fetching" },
      {
        id: "cryptoAgent",
        name: "Crypto Sub-Agent",
        desc: "Ticker price & mock DEX order execution",
      },
      { id: "codeAgent", name: "Code Sub-Agent", desc: "TypeScript & Python Firecracker Sandbox" },
    ],
  },
  {
    id: "background_agent",
    label: "Background Graph (background_agent)",
    entrypoint: "./backend/background-agent.ts",
    icon: Workflow,
    description: "Asynchronous background processing and thread summarization",
    agents: [
      {
        id: "threadSummarizeAgent",
        name: "Thread Summarizer",
        desc: "Context window compression & history summarization",
      },
      {
        id: "renameThreadAgent",
        name: "Title Generator",
        desc: "Automatic thread title generation",
      },
    ],
  },
  {
    id: "kbAgent",
    label: "Knowledge Base Graph (kbAgent)",
    entrypoint: "./backend/agent/kb-agent.ts",
    icon: Database,
    description: "PDF OCR vision parsing, GraphRAG entity extraction, and canonical alignment",
    agents: [
      { id: "kbOcrAgent", name: "KB OCR Digitizer", desc: "PDF page vision to clean Markdown" },
      {
        id: "kbEntityExtractAgent",
        name: "GraphRAG Extract",
        desc: "Entity, relation & theme triple extraction",
      },
      {
        id: "kbEntityAlignAgent",
        name: "GraphRAG Align",
        desc: "Cross-chunk canonical entity deduplication",
      },
    ],
  },
  {
    id: "evalAgent",
    label: "Judge Eval Graph (evalAgent)",
    entrypoint: "./backend/agent/eval-agent.ts",
    icon: Scale,
    description: "LLM-as-a-Judge offline/online scoring agent",
    agents: [
      { id: "evalJudgeAgent", name: "Eval Judge Agent", desc: "Automated scoring against rubric" },
    ],
  },
];

export function EvalDashboardClient() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [stats, setStats] = useState<VariantStat[]>([]);
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([]);
  const [assignments, setAssignments] = useState<UserAssignment[]>([]);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [judgments, setJudgments] = useState<Judgment[]>([]);
  const [loading, setLoading] = useState(true);

  // Active Sub-Tab
  const [subTab, setSubTab] = useState("prompts");

  // Trace Detail Drawer / Modal
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [traceDetail, setTraceDetail] = useState<RunTraceDetail | null>(null);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const [evaluating, setEvaluating] = useState(false);

  // New Prompt Variant Dialog
  const [addingVariantTmplId, setAddingVariantTmplId] = useState<string | null>(null);
  const [newVarLabel, setNewVarLabel] = useState("");
  const [newVarWeight, setNewVarWeight] = useState("50");

  // Deploy Prompt Version Dialog State
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const [targetAgentForNew, setTargetAgentForNew] = useState("chatAgent");
  const [newPromptContent, setNewPromptContent] = useState("");
  const [newPromptNotes, setNewPromptNotes] = useState("");
  const [creatingTmpl, setCreatingTmpl] = useState(false);

  // User Filter for Assignments
  const [userSearch, setUserSearch] = useState("");

  // Collapsible Groups State
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const toggleGroupCollapse = (groupId: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const fetchData = async () => {
    try {
      setLoading(true);
      const [promptsRes, compareRes, assignRes, rubricsRes] = await Promise.all([
        fetch("/api/eval/prompts"),
        fetch("/api/eval/runs/compare"),
        fetch("/api/eval/assignments"),
        fetch("/api/eval/rubrics"),
      ]);

      if (promptsRes.ok) {
        const pData = await promptsRes.json();
        setTemplates(pData.templates || []);
        setVariants(pData.variants || []);
      }

      if (compareRes.ok) {
        const cData = await compareRes.json();
        setStats(cData.stats || []);
        setRecentRuns(cData.recentRuns || []);
      }

      if (assignRes.ok) {
        const aData = await assignRes.json();
        setAssignments(aData.assignments || []);
      }

      if (rubricsRes.ok) {
        const rData = await rubricsRes.json();
        setRubrics(rData.rubrics || []);
        setJudgments(rData.judgments || []);
      }
    } catch (err) {
      console.error("Failed to load eval dashboard data:", err);
      toast.error("Failed to fetch evaluation data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleUpdateWeight = async (variantId: string, weight: number) => {
    try {
      const res = await fetch("/api/eval/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_variant_weight",
          variantId,
          trafficWeight: weight,
        }),
      });
      if (res.ok) {
        toast.success("Traffic weight updated");
        fetchData();
      } else {
        toast.error("Failed to update weight");
      }
    } catch (err) {
      console.error("Failed to update weight:", err);
    }
  };

  const handleAddVariant = async () => {
    if (!addingVariantTmplId || !newVarLabel.trim()) return;
    try {
      const res = await fetch("/api/eval/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_variant",
          templateId: addingVariantTmplId,
          label: newVarLabel.trim(),
          trafficWeight: parseInt(newVarWeight) || 50,
        }),
      });
      if (res.ok) {
        toast.success("New variant added");
        setAddingVariantTmplId(null);
        setNewVarLabel("");
        fetchData();
      } else {
        toast.error("Failed to create variant");
      }
    } catch (err) {
      console.error("Failed to create variant:", err);
    }
  };

  const handleCreateTemplate = async () => {
    if (!newPromptContent.trim()) {
      toast.error("Prompt content cannot be empty");
      return;
    }
    try {
      setCreatingTmpl(true);
      const res = await fetch("/api/eval/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_template",
          agent: targetAgentForNew,
          content: newPromptContent,
          notes: newPromptNotes.trim() || undefined,
        }),
      });
      if (res.ok) {
        toast.success(`Deployed prompt template for ${targetAgentForNew}`);
        setNewPromptContent("");
        setNewPromptNotes("");
        setDeployModalOpen(false);
        fetchData();
      } else {
        toast.error("Failed to deploy template");
      }
    } catch (err) {
      console.error("Failed to create template:", err);
    } finally {
      setCreatingTmpl(false);
    }
  };

  const openDeployDialogForAgent = (agentId: string) => {
    setTargetAgentForNew(agentId);
    setNewPromptContent("");
    setNewPromptNotes("");
    setDeployModalOpen(true);
  };

  const openTraceDetail = async (runId: string) => {
    setSelectedRunId(runId);
    setLoadingTrace(true);
    try {
      const res = await fetch(`/api/eval/runs/${runId}`);
      if (res.ok) {
        const data = await res.json();
        setTraceDetail(data);
      }
    } catch (err) {
      console.error("Failed to load run trace detail:", err);
    } finally {
      setLoadingTrace(false);
    }
  };

  const triggerAIJudge = async (runId: string) => {
    setEvaluating(true);
    try {
      const res = await fetch("/api/eval/judge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      if (res.ok) {
        toast.success("AI Judge scoring complete!");
        if (selectedRunId === runId) {
          openTraceDetail(runId);
        }
        fetchData();
      } else {
        toast.error("AI Judge scoring failed");
      }
    } catch (err) {
      console.error("Failed to trigger AI Judge:", err);
    } finally {
      setEvaluating(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
        <Activity className="size-6 animate-spin text-primary" />
        <span className="text-sm font-medium">Loading Evaluation Platform...</span>
      </div>
    );
  }

  const filteredAssignments = assignments.filter(
    (a) =>
      !userSearch ||
      (a.userEmail && a.userEmail.toLowerCase().includes(userSearch.toLowerCase())) ||
      (a.userId && a.userId.toLowerCase().includes(userSearch.toLowerCase())) ||
      (a.agent && a.agent.toLowerCase().includes(userSearch.toLowerCase())),
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Top Header Bar with Standard Action Button */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="mt-2">
            <h2 className="font-semibold">Eval & A/B Platform</h2>
            <p className="text-muted-foreground text-xs mt-1">
              System prompts, A/B traffic variants, sticky user assignments, execution traces, and
              LLM-as-a-Judge scoring.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openDeployDialogForAgent("chatAgent")}
          >
            Add prompt
          </Button>
        </div>

        {/* 4 Main Sub-Tabs Navigation */}
        <Tabs value={subTab} onValueChange={setSubTab}>
          <TabsList className="grid grid-cols-2 md:grid-cols-4 h-11 w-full bg-muted/60 p-1 rounded-xl">
            <TabsTrigger
              value="prompts"
              className="flex items-center gap-2 text-xs font-semibold rounded-lg data-[state=active]:bg-background data-[state=active]:shadow-xs"
            >
              <Layers className="size-4 text-primary" /> Prompts & A/B Studio
              <Badge variant="secondary" className="ml-auto text-[10px] font-mono px-1.5 py-0">
                {templates.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger
              value="assignments"
              className="flex items-center gap-2 text-xs font-semibold rounded-lg data-[state=active]:bg-background data-[state=active]:shadow-xs"
            >
              <UserCheck className="size-4 text-primary" /> User Assignments
              <Badge variant="secondary" className="ml-auto text-[10px] font-mono px-1.5 py-0">
                {assignments.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger
              value="logs"
              className="flex items-center gap-2 text-xs font-semibold rounded-lg data-[state=active]:bg-background data-[state=active]:shadow-xs"
            >
              <Clock className="size-4 text-primary" /> Execution Logs & Traces
              <Badge variant="secondary" className="ml-auto text-[10px] font-mono px-1.5 py-0">
                {recentRuns.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger
              value="rubric"
              className="flex items-center gap-2 text-xs font-semibold rounded-lg data-[state=active]:bg-background data-[state=active]:shadow-xs"
            >
              <Scale className="size-4 text-primary" /> Rubric & AI Judgments
              <Badge variant="secondary" className="ml-auto text-[10px] font-mono px-1.5 py-0">
                {judgments.length}
              </Badge>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: Prompts & A/B Studio (targetGroupName Cards with Prompts Sub-Table) */}
      {/* ========================================================================= */}
      {subTab === "prompts" && (
        <div className="flex flex-col gap-6">
          {LANGGRAPH_GROUPS.map((group) => {
            const Icon = group.icon;
            const isCollapsed = collapsedGroups[group.id];
            const groupTemplates = templates.filter(
              (t) =>
                t.group === group.id ||
                (group.id === "agent" && (!t.group || t.group === "Main Assistant")),
            );

            return (
              <Card key={group.id} className="overflow-hidden border-border/80 py-0 gap-0">
                <CardHeader className={isCollapsed ? "p-6" : "pt-6 px-6 pb-3"}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <Icon className="size-4 text-primary shrink-0" />
                        <CardTitle className="text-base font-semibold">{group.label}</CardTitle>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {group.id}
                        </Badge>
                      </div>
                      <CardDescription className="text-xs">
                        <span className="font-mono">{group.entrypoint}</span>
                        <span className="mx-1.5">·</span>
                        {group.description}
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => openDeployDialogForAgent(group.agents[0]!.id)}
                      >
                        Add prompt
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => toggleGroupCollapse(group.id)}
                        className="gap-1.5"
                      >
                        <span>{isCollapsed ? "Expand" : "Collapse"}</span>
                        <ChevronDown
                          className={`size-3.5 transition-transform duration-200 ${
                            isCollapsed ? "-rotate-90" : "rotate-0"
                          }`}
                        />
                      </Button>
                    </div>
                  </div>
                </CardHeader>

                <div
                  className={`grid transition-all duration-300 ease-in-out ${
                    isCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
                  }`}
                >
                  <div className="overflow-hidden">
                    <CardContent className="px-6 pb-6 pt-0 flex flex-col gap-4">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                          Prompts ({groupTemplates.length} Template versions)
                        </span>
                      </div>

                      <div className="border-border/60 overflow-hidden rounded-lg border bg-card text-card-foreground">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-muted/40 border-b text-muted-foreground font-medium uppercase text-[10px]">
                            <tr>
                              <th className="px-4 py-2.5">Target Node (targetName)</th>
                              <th className="px-4 py-2.5">Template ID</th>
                              <th className="px-4 py-2.5">Notes / Rationale</th>
                              <th className="px-4 py-2.5">Active Variants & Traffic Weights</th>
                              <th className="px-4 py-2.5 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y">
                            {group.agents.map((agentObj) => {
                              const agentId = agentObj.id;
                              const agentTemplates = groupTemplates.filter(
                                (t) => t.agent === agentId,
                              );

                              if (agentTemplates.length === 0) {
                                return (
                                  <tr key={agentId} className="hover:bg-muted/20 transition-colors">
                                    <td className="px-4 py-3 font-mono font-semibold text-foreground align-top">
                                      <div className="flex items-center gap-1.5">
                                        <GitBranch className="size-3.5 text-primary shrink-0" />
                                        <span>{agentId}</span>
                                      </div>
                                      <span className="text-[10px] text-muted-foreground block mt-0.5 font-normal font-sans">
                                        {agentObj.name}
                                      </span>
                                    </td>
                                    <td
                                      colSpan={3}
                                      className="px-4 py-3 text-muted-foreground italic text-[11px] align-top"
                                    >
                                      No prompt template deployed yet.
                                    </td>
                                    <td className="px-4 py-3 text-right align-top">
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="xs"
                                        onClick={() => openDeployDialogForAgent(agentId)}
                                      >
                                        Add prompt
                                      </Button>
                                    </td>
                                  </tr>
                                );
                              }

                              return agentTemplates.map((tmpl, index) => {
                                const tmplVariants = variants.filter(
                                  (v) => v.templateId === tmpl.id,
                                );
                                const totalW = tmplVariants.reduce(
                                  (s, v) => s + Math.max(0, v.trafficWeight),
                                  0,
                                );

                                return (
                                  <tr key={tmpl.id} className="hover:bg-muted/20 transition-colors">
                                    {index === 0 ? (
                                      <td
                                        rowSpan={agentTemplates.length}
                                        className="px-4 py-3 align-top font-mono font-semibold text-foreground border-r border-border/40"
                                      >
                                        <div className="flex items-center gap-1.5">
                                          <GitBranch className="size-3.5 text-primary shrink-0" />
                                          <span>{agentId}</span>
                                        </div>
                                        <span className="text-[10px] text-muted-foreground block mt-0.5 font-normal font-sans">
                                          {agentObj.name}
                                        </span>
                                      </td>
                                    ) : null}
                                    <td className="px-4 py-3 font-mono font-medium text-foreground align-top">
                                      {tmpl.id}
                                    </td>
                                    <td className="px-4 py-3 align-top text-muted-foreground text-[11px]">
                                      {tmpl.notes || "—"}
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                      <div className="flex flex-col gap-2 max-w-sm">
                                        {tmplVariants.map((v) => {
                                          const pct =
                                            totalW > 0
                                              ? Math.round((v.trafficWeight / totalW) * 100)
                                              : 0;
                                          return (
                                            <div
                                              key={v.id}
                                              className="flex flex-col gap-1 bg-muted/30 p-2 rounded-md"
                                            >
                                              <div className="flex items-center justify-between text-[11px]">
                                                <span className="font-semibold text-foreground">
                                                  {v.label} ({v.id})
                                                </span>
                                                <Badge
                                                  variant="outline"
                                                  className="font-mono text-[10px]"
                                                >
                                                  {pct}% Traffic
                                                </Badge>
                                              </div>
                                              <div className="flex items-center gap-2">
                                                <input
                                                  type="range"
                                                  min="0"
                                                  max="100"
                                                  value={v.trafficWeight}
                                                  onChange={(e) =>
                                                    handleUpdateWeight(
                                                      v.id,
                                                      parseInt(e.target.value),
                                                    )
                                                  }
                                                  className="h-1.5 flex-1 cursor-pointer accent-primary rounded-lg bg-muted"
                                                />
                                                <span className="font-mono text-[10px] w-6 text-right">
                                                  {v.trafficWeight}
                                                </span>
                                              </div>
                                            </div>
                                          );
                                        })}
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="xs"
                                          className="w-fit mt-0.5"
                                          onClick={() => setAddingVariantTmplId(tmpl.id)}
                                        >
                                          Add variant
                                        </Button>
                                      </div>
                                    </td>
                                    <td className="px-4 py-3 text-right align-top">
                                      <div className="flex justify-end gap-1">
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="xs"
                                          onClick={() => openDeployDialogForAgent(agentId)}
                                        >
                                          Add prompt
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="xs"
                                          onClick={() => copyToClipboard(tmpl.content)}
                                          title="Copy Full Prompt Content"
                                        >
                                          Copy
                                        </Button>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              });
                            })}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: User A/B Variant Assignments (prompt_variant_assignment Table) */}
      {/* ========================================================================= */}
      {subTab === "assignments" && (
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
                onChange={(e) => setUserSearch(e.target.value)}
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
      )}

      {/* ========================================================================= */}
      {/* TAB 3: Execution Logs & Traces (eval_run + Trace Drawer + Trigger AI Judge) */}
      {/* ========================================================================= */}
      {subTab === "logs" && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold">Execution Traces & AI Judge Trigger</h3>
              <p className="text-muted-foreground text-xs mt-0.5">
                Inspect live evaluation run traces, input/output messages, token consumption, and
                trigger LLM-as-a-Judge scoring.
              </p>
            </div>
            <Badge variant="secondary" className="font-mono text-xs">
              {recentRuns.length} Total Run Logs
            </Badge>
          </div>

          <div className="border-border/80 overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/50 border-b text-muted-foreground font-medium uppercase text-[10px]">
                <tr>
                  <th className="px-4 py-3">Run ID</th>
                  <th className="px-4 py-3">Agent Node</th>
                  <th className="px-4 py-3">Variant</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-right">Latency</th>
                  <th className="px-4 py-3 text-center">User Rating</th>
                  <th className="px-4 py-3 text-center">AI Judge Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {recentRuns.map((run) => (
                  <tr key={run.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3 font-mono text-[11px] font-medium text-foreground">
                      {run.id}
                    </td>
                    <td className="px-4 py-3 font-mono text-muted-foreground">{run.agent}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {run.label || run.variantId}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {run.status === "success" ? (
                        <span className="inline-flex items-center gap-1 text-emerald-500 font-medium text-[11px]">
                          <CheckCircle2 className="size-3" /> success
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-rose-500 font-medium text-[11px]">
                          <XCircle className="size-3" /> {run.status}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {run.totalMs} ms
                    </td>
                    <td className="px-4 py-3 text-center font-medium">
                      {run.userRating === 5 ? (
                        <span className="inline-flex items-center gap-1 text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded-full text-[10px]">
                          <ThumbsUp className="size-3" /> 5 (Up)
                        </span>
                      ) : run.userRating === 1 ? (
                        <span className="inline-flex items-center gap-1 text-rose-500 bg-rose-500/10 px-1.5 py-0.5 rounded-full text-[10px]">
                          <ThumbsDown className="size-3" /> 1 (Down)
                        </span>
                      ) : run.userRating ? (
                        <span className="text-amber-500 font-mono">{run.userRating} ★</span>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => triggerAIJudge(run.id)}
                        disabled={evaluating}
                      >
                        {evaluating ? "Scoring..." : "Run AI judge"}
                      </Button>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => openTraceDetail(run.id)}
                      >
                        View trace
                      </Button>
                    </td>
                  </tr>
                ))}
                {recentRuns.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-muted-foreground px-4 py-8 text-center text-xs">
                      No evaluation execution logs recorded yet. Start a chat session to generate
                      live runs!
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 4: Rubric & AI Judgments (eval_rubric & eval_judgment Tables) */}
      {/* ========================================================================= */}
      {subTab === "rubric" && (
        <div className="flex flex-col gap-6">
          {/* Section 1: Active Rubric Criteria */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Scale className="size-4 text-primary" /> Evaluation Rubric Criteria (eval_rubric)
              </h3>
              <Badge variant="outline" className="font-mono text-xs">
                {rubrics.length} Rubric(s) Configured
              </Badge>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {rubrics.map((rubric) => (
                <Card key={rubric.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm font-semibold">{rubric.name}</CardTitle>
                      <Badge variant="secondary" className="font-mono text-[10px]">
                        {rubric.id}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2 text-xs">
                    <span className="font-medium text-muted-foreground uppercase text-[10px]">
                      Evaluation Criteria & Weights
                    </span>
                    <div className="flex flex-col gap-1.5">
                      {rubric.criteria.map((c) => (
                        <div
                          key={c.name}
                          className="flex items-center justify-between bg-muted/40 rounded-md p-2"
                        >
                          <div className="flex flex-col">
                            <span className="font-semibold text-foreground">{c.name}</span>
                            <span className="text-[11px] text-muted-foreground">
                              {c.description}
                            </span>
                          </div>
                          <Badge variant="default" className="font-mono text-xs">
                            {Math.round(c.weight * 100)}%
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          <Separator />

          {/* Section 2: AI Judgment Scoring History */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Bot className="size-4 text-primary" /> AI Judge Scoring History (eval_judgment)
              </h3>
              <Badge variant="secondary" className="font-mono text-xs">
                {judgments.length} Judgment(s)
              </Badge>
            </div>

            <div className="border-border/80 overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50 border-b text-muted-foreground font-medium uppercase text-[10px]">
                  <tr>
                    <th className="px-4 py-3">Judgment ID</th>
                    <th className="px-4 py-3">Run ID</th>
                    <th className="px-4 py-3">Agent Node</th>
                    <th className="px-4 py-3">Scores Breakdown</th>
                    <th className="px-4 py-3">Reasoning Summary</th>
                    <th className="px-4 py-3 text-right">Cost Tokens</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {judgments.map((jg) => (
                    <tr key={jg.id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-3 font-mono font-medium text-foreground">{jg.id}</td>
                      <td className="px-4 py-3 font-mono text-muted-foreground">{jg.runId}</td>
                      <td className="px-4 py-3 font-mono">{jg.agent || "—"}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(jg.scores || {}).map(([key, val]) => (
                            <Badge key={key} variant="outline" className="font-mono text-[10px]">
                              {key}: {val}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-[11px] max-w-[280px] truncate">
                        {jg.reasoning}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {jg.totalCostTokens ?? 0} tok
                      </td>
                    </tr>
                  ))}
                  {judgments.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="text-muted-foreground px-4 py-8 text-center text-xs"
                      >
                        No AI Judge evaluation history recorded yet. Trigger AI Judge on an
                        execution run to generate scores!
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* Deploy Prompt Version Modal */}
      <Dialog open={deployModalOpen} onOpenChange={setDeployModalOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Add prompt version</DialogTitle>
            <DialogDescription className="text-xs">
              Create a new System Prompt template version for node{" "}
              <span className="font-mono font-semibold text-foreground">{targetAgentForNew}</span>.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3.5 text-xs py-2">
            <label className="flex flex-col gap-1">
              <span className="font-medium text-foreground">Target Agent Node</span>
              <Select value={targetAgentForNew} onValueChange={setTargetAgentForNew}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGGRAPH_GROUPS.flatMap((g) => g.agents).map((a) => (
                    <SelectItem key={a.id} value={a.id} className="text-xs">
                      {a.name} ({a.id})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-medium text-foreground">Version Notes / Rationale</span>
              <Input
                value={newPromptNotes}
                onChange={(e) => setNewPromptNotes(e.target.value)}
                placeholder="e.g. Optimized RAG instructions & concise tone"
                className="h-9 text-xs"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-medium text-foreground">System Prompt Template</span>
              <textarea
                value={newPromptContent}
                onChange={(e) => setNewPromptContent(e.target.value)}
                placeholder="You are an AI assistant..."
                className="bg-background border-border min-h-[180px] rounded-md border p-2.5 font-mono text-xs focus:outline-hidden leading-relaxed"
              />
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDeployModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateTemplate} disabled={creatingTmpl}>
              {creatingTmpl ? "Deploying..." : "Add prompt"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Variant Modal */}
      <Dialog
        open={Boolean(addingVariantTmplId)}
        onOpenChange={(o) => !o && setAddingVariantTmplId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add A/B Traffic Variant</DialogTitle>
            <DialogDescription>
              Add a new variant for template{" "}
              <span className="font-mono font-semibold">{addingVariantTmplId}</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 text-xs py-2">
            <label className="flex flex-col gap-1.5">
              <span className="font-medium">Variant Label</span>
              <Input
                value={newVarLabel}
                onChange={(e) => setNewVarLabel(e.target.value)}
                placeholder="e.g. treatment_b"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="font-medium">Initial Traffic Weight</span>
              <Input
                type="number"
                value={newVarWeight}
                onChange={(e) => setNewVarWeight(e.target.value)}
                placeholder="50"
              />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddingVariantTmplId(null)}>
              Cancel
            </Button>
            <Button onClick={handleAddVariant}>Add variant</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Run Trace Detail Drawer / Modal */}
      <Dialog open={Boolean(selectedRunId)} onOpenChange={(o) => !o && setSelectedRunId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="size-4 text-primary" /> Execution Run Trace Detail
            </DialogTitle>
            <DialogDescription className="font-mono text-xs">
              Run ID: {selectedRunId}
            </DialogDescription>
          </DialogHeader>

          {loadingTrace ? (
            <div className="py-8 text-center text-muted-foreground text-xs animate-pulse">
              Loading trace context & spans...
            </div>
          ) : traceDetail ? (
            <div className="flex flex-col gap-4 text-xs max-h-[480px] overflow-y-auto pr-1">
              <div className="grid grid-cols-3 gap-2 bg-muted/40 p-3 rounded-lg font-mono">
                <div>
                  <span className="text-[10px] text-muted-foreground block uppercase">
                    Agent Node
                  </span>
                  <span className="font-semibold text-foreground">{traceDetail.run.agent}</span>
                </div>
                <div>
                  <span className="text-[10px] text-muted-foreground block uppercase">Variant</span>
                  <span className="font-semibold text-foreground">
                    {traceDetail.run.label || traceDetail.run.variantId}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-muted-foreground block uppercase">
                    Total Latency
                  </span>
                  <span className="font-semibold text-foreground">
                    {traceDetail.run.totalMs} ms
                  </span>
                </div>
              </div>

              {traceDetail.judgment ? (
                <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-primary flex items-center gap-1.5">
                      <Bot className="size-4" /> AI Judge Score Result
                    </span>
                    <Badge variant="default" className="font-mono text-xs">
                      {traceDetail.judgment.scores.overall ?? 85} / 100
                    </Badge>
                  </div>
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    {traceDetail.judgment.reasoning}
                  </p>
                </div>
              ) : (
                <div className="flex items-center justify-between bg-muted/30 border border-dashed rounded-lg p-3">
                  <span className="text-muted-foreground text-xs">
                    AI Judge scoring not triggered for this run yet.
                  </span>
                  <Button
                    size="xs"
                    onClick={() => selectedRunId && triggerAIJudge(selectedRunId)}
                    disabled={evaluating}
                  >
                    {evaluating ? "Evaluating..." : "Run AI judge"}
                  </Button>
                </div>
              )}

              <Separator />

              <div className="flex flex-col gap-2">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  <Code2 className="size-4 text-primary" /> Execution Spans (
                  {traceDetail.spans?.length || 0})
                </span>
                <div className="flex flex-col gap-1.5">
                  {traceDetail.spans?.map((span) => (
                    <div
                      key={span.id}
                      className="flex items-center justify-between bg-muted/20 border p-2 rounded-md font-mono text-[11px]"
                    >
                      <span>{span.name}</span>
                      <span className="text-muted-foreground">{span.durationMs} ms</span>
                    </div>
                  ))}
                  {(!traceDetail.spans || traceDetail.spans.length === 0) && (
                    <div className="text-muted-foreground italic text-xs py-2">
                      No explicit span sub-steps recorded.
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedRunId(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

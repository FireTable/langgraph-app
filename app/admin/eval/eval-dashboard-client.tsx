"use client";

import React, { useEffect, useState } from "react";
import { Activity, Clock, Layers, Scale, UserCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { UserAssignmentsTab } from "./assignments";
import { ExecutionLogsTab, TraceDetailDialog } from "./logs";
import {
  AddCohortVariantDialog,
  DeletePromptDialog,
  DeployPromptDialog,
  EditPromptDialog,
  PromptsStudioTab,
  TrafficItem,
  TrafficSplitDialog,
} from "./prompts";
import { RubricJudgmentsTab } from "./rubric";
import {
  Judgment,
  RecentRun,
  Rubric,
  RunTraceDetail,
  Template,
  UserAssignment,
  Variant,
  VariantStat,
} from "./types";

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

  // New / Edit Experiment Cohort Dialog State
  const [addCohortDialogOpen, setAddCohortDialogOpen] = useState(false);
  const [editingCohortData, setEditingCohortData] = useState<{
    label: string;
    trafficWeight: number;
    bindings: Record<string, string>;
  } | null>(null);
  const [submittingCohort, setSubmittingCohort] = useState(false);

  // User Assignment Override State
  const [overridingUserId, setOverridingUserId] = useState<string | null>(null);

  // Deploy Prompt Version Dialog State
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const [targetAgentForNew, setTargetAgentForNew] = useState("chatAgent");
  const [newPromptContent, setNewPromptContent] = useState("");
  const [newPromptNotes, setNewPromptNotes] = useState("");
  const [creatingTmpl, setCreatingTmpl] = useState(false);

  // Traffic Split Allocation Modal State
  const [trafficModalAgent, setTrafficModalAgent] = useState<string | null>(null);
  const [trafficItems, setTrafficItems] = useState<TrafficItem[]>([]);
  const [savingTraffic, setSavingTraffic] = useState(false);

  // Edit Prompt Template Modal State
  const [editModalTemplate, setEditModalTemplate] = useState<Template | null>(null);
  const [editNotes, setEditNotes] = useState("");
  const [editContent, setEditContent] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Delete Prompt Template Modal State
  const [deleteModalTemplate, setDeleteModalTemplate] = useState<Template | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState(false);

  // User Filter for Assignments
  const [userSearch, setUserSearch] = useState("");

  // Collapsible Groups State
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const toggleGroupCollapse = (groupId: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const handleOpenEditCohort = (
    label: string,
    weight: number,
    bindings: Record<string, string>,
  ) => {
    setEditingCohortData({ label, trafficWeight: weight, bindings });
    setAddCohortDialogOpen(true);
  };

  const handleCreateCohortVariant = async (cohortData: {
    label: string;
    trafficWeight: number;
    bindings: Record<string, string>;
  }) => {
    setSubmittingCohort(true);
    try {
      const res = await fetch("/api/eval/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_cohort_variant",
          ...cohortData,
        }),
      });
      if (!res.ok) throw new Error("Failed to save variant");
      toast.success(
        editingCohortData
          ? `Updated variant "${cohortData.label}"`
          : `Created variant "${cohortData.label}"`,
      );
      setAddCohortDialogOpen(false);
      setEditingCohortData(null);
      fetchData();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error saving variant");
    } finally {
      setSubmittingCohort(false);
    }
  };

  const handleOverrideUserCohort = async (userId: string, cohortLabel: string) => {
    setOverridingUserId(userId);
    try {
      const res = await fetch("/api/eval/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          cohortLabel,
        }),
      });
      if (!res.ok) throw new Error("Failed to override assignment");
      toast.success(`User variant assigned to "${cohortLabel}"`);
      fetchData();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error overriding assignment");
    } finally {
      setOverridingUserId(null);
    }
  };

  const handleDeleteCohort = async (cohortLabel: string) => {
    if (cohortLabel.toLowerCase() === "default") {
      toast.error("Default variant cannot be deleted");
      return;
    }
    if (!confirm(`Are you sure you want to delete variant "${cohortLabel}"?`)) {
      return;
    }
    try {
      const cohortVariants = variants.filter((v) => v.label === cohortLabel);
      for (const v of cohortVariants) {
        await fetch(`/api/eval/prompts?id=${v.id}`, { method: "DELETE" });
      }
      toast.success(`Variant "${cohortLabel}" deleted`);
      fetchData();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error deleting variant");
    }
  };

  const openTrafficModal = (agentId: string) => {
    const agentTemplates = templates.filter((t) => t.agent === agentId);
    const agentTmplIds = new Set(agentTemplates.map((t) => t.id));
    const agentVars = variants.filter((v) => agentTmplIds.has(v.templateId));

    const items = agentVars.map((v) => ({
      variantId: v.id,
      label: v.label,
      templateId: v.templateId,
      weight: v.trafficWeight,
      enabled: v.enabled,
    }));

    setTrafficItems(items);
    setTrafficModalAgent(agentId);
  };

  const handleAutoBalanceTraffic = () => {
    const enabledItems = trafficItems.filter((i) => i.enabled);
    if (enabledItems.length === 0) return;
    const equalShare = Math.floor(100 / enabledItems.length);
    const remainder = 100 - equalShare * enabledItems.length;

    setTrafficItems((prev) => {
      let enabledCount = 0;
      return prev.map((item) => {
        if (!item.enabled) return { ...item, weight: 0 };
        enabledCount++;
        const weight = equalShare + (enabledCount === 1 ? remainder : 0);
        return { ...item, weight };
      });
    });
  };

  const handleSaveTrafficWeights = async () => {
    const activeSum = trafficItems
      .filter((i) => i.enabled)
      .reduce((s, i) => s + (i.weight || 0), 0);
    if (activeSum !== 100 && trafficItems.some((i) => i.enabled)) {
      toast.error("The sum of enabled traffic weights must equal exactly 100%");
      return;
    }

    setSavingTraffic(true);
    try {
      const res = await fetch("/api/eval/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "batch_update_weights",
          agent: trafficModalAgent,
          variants: trafficItems.map((i) => ({
            id: i.variantId,
            trafficWeight: i.enabled ? i.weight : 0,
            enabled: i.enabled,
          })),
        }),
      });
      if (!res.ok) throw new Error("Failed to save traffic split");
      toast.success("Traffic weight allocation updated successfully!");
      setTrafficModalAgent(null);
      fetchData();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error saving traffic split");
    } finally {
      setSavingTraffic(false);
    }
  };

  const openEditModal = (tmpl: Template) => {
    setEditModalTemplate(tmpl);
    setEditNotes(tmpl.notes || "");
    setEditContent(tmpl.content || "");
  };

  const handleSaveEditTemplate = async () => {
    if (!editModalTemplate) return;
    if (!editContent.trim()) {
      toast.error("Prompt content cannot be empty");
      return;
    }
    setSavingEdit(true);
    try {
      const res = await fetch("/api/eval/prompts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editModalTemplate.id,
          content: editContent.trim(),
          notes: editNotes.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error("Failed to update template");
      toast.success("Prompt template updated successfully!");
      setEditModalTemplate(null);
      fetchData();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error updating template");
    } finally {
      setSavingEdit(false);
    }
  };

  const openDeleteModal = (tmpl: Template) => {
    if (!tmpl.userId) {
      toast.error("System default prompts cannot be deleted");
      return;
    }
    setDeleteModalTemplate(tmpl);
  };

  const handleConfirmDeleteTemplate = async () => {
    if (!deleteModalTemplate) return;
    setDeletingTemplate(true);
    try {
      const res = await fetch(`/api/eval/prompts?id=${deleteModalTemplate.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to delete template");
      }
      toast.success(`Prompt template "${deleteModalTemplate.id}" deleted`);
      setDeleteModalTemplate(null);
      fetchData();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error deleting template");
    } finally {
      setDeletingTemplate(false);
    }
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

  return (
    <div className="flex flex-col gap-6">
      {/* Top Header Bar with Sub-Tab Switcher */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="mt-2">
            <h2 className="font-semibold">Eval & A/B Platform</h2>
            <p className="text-muted-foreground text-xs mt-1">
              System prompts, A/B traffic variants, sticky user assignments, execution traces, and
              LLM-as-a-Judge scoring.
            </p>
          </div>
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

      {/* Sub-Tab Content Rendering */}
      {subTab === "prompts" && (
        <PromptsStudioTab
          templates={templates}
          variants={variants}
          collapsedGroups={collapsedGroups}
          toggleGroupCollapse={toggleGroupCollapse}
          openTrafficModal={openTrafficModal}
          openAddCohortDialog={() => {
            setEditingCohortData(null);
            setAddCohortDialogOpen(true);
          }}
          openEditCohortDialog={handleOpenEditCohort}
          openDeployDialogForAgent={openDeployDialogForAgent}
          copyToClipboard={copyToClipboard}
          openEditModal={openEditModal}
          openDeleteModal={openDeleteModal}
          onDeleteCohort={handleDeleteCohort}
        />
      )}

      {subTab === "assignments" && (
        <UserAssignmentsTab
          assignments={assignments}
          variants={variants}
          userSearch={userSearch}
          onSearchChange={setUserSearch}
          onOverrideCohort={handleOverrideUserCohort}
          overridingUserId={overridingUserId}
        />
      )}

      {subTab === "logs" && (
        <ExecutionLogsTab
          recentRuns={recentRuns}
          onTriggerJudge={triggerAIJudge}
          evaluating={evaluating}
          onOpenTraceDetail={openTraceDetail}
        />
      )}

      {subTab === "rubric" && (
        <RubricJudgmentsTab rubrics={rubrics} judgments={judgments} />
      )}

      {/* Dialog Modals */}
      <DeployPromptDialog
        open={deployModalOpen}
        onOpenChange={setDeployModalOpen}
        targetAgent={targetAgentForNew}
        onTargetAgentChange={setTargetAgentForNew}
        content={newPromptContent}
        onContentChange={setNewPromptContent}
        notes={newPromptNotes}
        onNotesChange={setNewPromptNotes}
        onSubmit={handleCreateTemplate}
        loading={creatingTmpl}
      />

      <AddCohortVariantDialog
        open={addCohortDialogOpen}
        onOpenChange={(o) => {
          setAddCohortDialogOpen(o);
          if (!o) setEditingCohortData(null);
        }}
        templates={templates}
        initialCohort={editingCohortData}
        onSubmit={handleCreateCohortVariant}
        submitting={submittingCohort}
      />

      <TrafficSplitDialog
        agentId={trafficModalAgent}
        onOpenChange={(o) => !o && setTrafficModalAgent(null)}
        items={trafficItems}
        setItems={setTrafficItems}
        onAutoBalance={handleAutoBalanceTraffic}
        onSave={handleSaveTrafficWeights}
        saving={savingTraffic}
      />

      <EditPromptDialog
        template={editModalTemplate}
        onOpenChange={(o) => !o && setEditModalTemplate(null)}
        notes={editNotes}
        onNotesChange={setEditNotes}
        content={editContent}
        onContentChange={setEditContent}
        onSave={handleSaveEditTemplate}
        saving={savingEdit}
      />

      <DeletePromptDialog
        template={deleteModalTemplate}
        onOpenChange={(o) => !o && setDeleteModalTemplate(null)}
        onConfirm={handleConfirmDeleteTemplate}
        deleting={deletingTemplate}
      />

      <TraceDetailDialog
        runId={selectedRunId}
        onOpenChange={(o) => !o && setSelectedRunId(null)}
        loading={loadingTrace}
        traceDetail={traceDetail}
        onTriggerJudge={triggerAIJudge}
        evaluating={evaluating}
      />
    </div>
  );
}

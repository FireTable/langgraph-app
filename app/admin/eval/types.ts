import { Cpu, Database, Scale, Workflow } from "lucide-react";

export type Template = {
  id: string;
  group: string;
  agent: string;
  content: string;
  notes?: string;
  userId?: string | null;
  createdAt: string;
};

export type Variant = {
  id: string;
  templateId: string;
  label: string;
  trafficWeight: number;
  enabled: boolean;
};

export type VariantStat = {
  variantId: string;
  label: string;
  totalRuns: number;
  avgTotalMs: number;
  avgRating: number;
};

export type RecentRun = {
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
  judgment?: Judgment;
};

export type UserAssignment = {
  userId: string;
  userName?: string;
  userEmail?: string;
  userImage?: string | null;
  variantId: string;
  variantLabel?: string;
  templateId?: string;
  agent?: string;
  assignedAt: string;
};

export type Rubric = {
  id: string;
  name: string;
  criteria: Array<{ name: string; description: string; weight: number }>;
};

export type Judgment = {
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

export type RunTraceDetail = {
  run: RecentRun;
  feedback?: { rating: number; reason?: string };
  judgment?: Judgment;
  spans?: Array<{ id: string; name: string; durationMs: number; error?: string }>;
};

export const LANGGRAPH_GROUPS = [
  {
    id: "agent",
    label: "Main Chat Graph",
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
    label: "Background Graph",
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
    label: "Knowledge Base Graph",
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

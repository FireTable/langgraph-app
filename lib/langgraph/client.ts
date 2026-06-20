import "server-only";
import { Client } from "@langchain/langgraph-sdk";

// Shared LangGraph SDK Client for server-side calls (e.g. registering a
// thread we just created with our own threads table into langgraphjs dev's
// internal STORE). Browser code should keep building its own Client via
// the /api proxy — this module is server-only.
//
// Reads LANGGRAPH_API_URL (default http://localhost:2024) and
// LANGCHAIN_API_KEY from the env, matching what app/api/[..._path]/route.ts
// uses as the proxy target so the SDK hits the same backend.
const apiUrl = process.env.LANGGRAPH_API_URL ?? "http://localhost:2024";
const apiKey = process.env.LANGCHAIN_API_KEY;

export const langGraphClient = new Client({ apiUrl, apiKey: apiKey || undefined });

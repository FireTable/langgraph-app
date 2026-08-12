export type PublicProviderApiKey = { name: string };
// ponytail: mirrors lib/provider/schema.ts ModelKind + the new "pic"
// kind (canvas image generation, fal.ai-backed). Keeping the local
// re-declaration here lets the admin bundle ship without pulling in
// drizzle schema types — and the kind union stays in lockstep with
// lib/credit/zod.ts modelKindSchema.
export type ModelKind = "chat" | "ocr" | "embed" | "extract" | "rerank" | "eval" | "pic";

export type PublicModel = {
  name: string;
  enabled: boolean;
  inputPer1k: number;
  outputPer1k: number;
  kind?: ModelKind[];
};

export type PublicProviderRow = {
  id: string;
  name: string;
  enabled: boolean;
  baseUrl: string;
  apiKeys: PublicProviderApiKey[];
  models: PublicModel[];
  createdAt: string;
  updatedAt: string;
};

export type RoleRow = {
  id: string;
  name: string;
  creditLimit: number | null;
  windowHours: number;
  createdAt: string;
  updatedAt: string;
};

export const DEFAULT_KIND: ModelKind[] = ["chat"];

export type UserRow = {
  id: string;
  name: string | null;
  email: string;
  image?: string | null;
  emailVerified: boolean;
  roleId: string;
  roleName: string | null;
  banned: boolean;
  createdAt: string;
  updatedAt: string;
  todayCredits?: number;
  todayInputTokens?: number;
  todayOutputTokens?: number;
  todayTokens?: number;
  totalCredits?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
};

export async function jsonFetch<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: T | { code: string; message?: string } }> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as T | { code: string; message?: string };
  return { ok: res.ok, status: res.status, body };
}

export function errMsg(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const m = (body as { message?: string }).message;
    const c = (body as { code?: string }).code;
    if (m) return m;
    if (c) return c;
  }
  return "request failed";
}

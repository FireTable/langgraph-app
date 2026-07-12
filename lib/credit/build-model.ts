import { ChatOpenAI } from "@langchain/openai";
// ChatAnthropic may or may not be installed — see dispatch below.
// import { ChatAnthropic } from "@langchain/anthropic";
import { db } from "@/db/client";
import { provider } from "@/lib/provider/schema";
import { eq } from "drizzle-orm";
import { aesGcmDecrypt, loadKek } from "@/lib/auth/encryption";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export async function buildChatModel(
  providerId: string,
  modelName: string,
): Promise<BaseChatModel> {
  const [row] = await db.select().from(provider).where(eq(provider.id, providerId));
  if (!row) throw new Error(`provider not found: ${providerId}`);

  const model = row.models.find((m) => m.name === modelName);
  if (!model) throw new Error(`model ${modelName} not in provider ${providerId}`);
  if (!model.enabled) throw new Error(`model ${modelName} is disabled`);

  const firstKey = row.apiKeys[0];
  let apiKey: string | undefined;

  if (firstKey) {
    const kek = loadKek();
    apiKey = aesGcmDecrypt(firstKey.encryptedKey, firstKey.iv, kek);
  } else {
    // ponytail: env fallback covers first-run / pre-`provider` deployments.
    apiKey = process.env.OPENAI_API_KEY;
  }

  const baseUrl = row.baseUrl ?? undefined;

  if (!apiKey) {
    throw new Error(`no api keys for provider ${providerId} (and no OPENAI_API_KEY env fallback)`);
  }

  // ponytail: mirror backend/model.ts kwargs so behavior doesn't shift
  // when this helper replaces direct ChatOpenAI construction.
  if (providerId === "openai") {
    return new ChatOpenAI({
      apiKey,
      model: modelName,
      ...(baseUrl ? { configuration: { baseURL: baseUrl } } : {}),
      modelKwargs: { reasoning_split: true },
    });
  }

  throw new Error(`unsupported provider: ${providerId} (only 'openai' wired in MVP)`);
}

export async function getModelRate(
  providerId: string,
  modelName: string,
): Promise<{ inputPer1k: number; outputPer1k: number }> {
  const [row] = await db.select().from(provider).where(eq(provider.id, providerId));
  if (!row) throw new Error(`provider not found: ${providerId}`);
  const model = row.models.find((m) => m.name === modelName);
  if (!model) throw new Error(`model ${modelName} not in provider ${providerId}`);
  return { inputPer1k: model.inputPer1k, outputPer1k: model.outputPer1k };
}

/**
 * Resolve providerId from callback metadata. baseURL is the strong signal
 * (tells us which endpoint the call actually hit — read off the ChatModel
 * instance in resolveRunMeta); modelName is the fallback for providers
 * without a configured baseUrl (e.g. env OPENAI_BASE_URL).
 *
 * Returns null when neither matches — caller skips recording.
 */
export async function findProviderId(opts: {
  baseUrl?: string | null;
  modelName?: string;
}): Promise<string | null> {
  const rows = await db.select().from(provider);
  if (opts.baseUrl) {
    for (const row of rows) {
      if (row.baseUrl === opts.baseUrl) return row.id;
    }
  }
  if (opts.modelName) {
    for (const row of rows) {
      if (row.models.some((m) => m.name === opts.modelName && m.enabled)) return row.id;
    }
  }
  return null;
}

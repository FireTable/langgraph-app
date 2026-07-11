import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { role, user } from "@/lib/auth/schema";
import { creditUsageLog } from "@/lib/credit/schema";
import { provider } from "@/lib/provider/schema";
import { CreditTrackingHandler } from "@/lib/credit/callback";
import { QuotaExceededError } from "@/lib/credit/errors";
import { randomUUID } from "node:crypto";

// ponytail: minimal integration test for the callback. We mock the
// langchain `output` shape (LLMResult) directly so we don't need a
// real ChatModel — the callback's job is to read the result and record,
// not to invoke models.
function makeLlmResult(usage: { input: number; output: number }) {
  return {
    generations: [
      [
        {
          message: {
            usage_metadata: {
              input_tokens: usage.input,
              output_tokens: usage.output,
            },
          },
        },
      ],
    ],
  } as never;
}

describe("CreditTrackingHandler", () => {
  const testUserIds: string[] = [];

  beforeAll(async () => {
    // Re-seed roles idempotently — other tests may have wiped them.
    await db
      .insert(role)
      .values([
        { id: "guest", name: "Guest", creditLimit: 20, windowHours: 24 },
        { id: "user", name: "User", creditLimit: 200, windowHours: 24 },
        { id: "admin", name: "Admin", creditLimit: null, windowHours: 24 },
      ])
      .onConflictDoNothing();
  });

  // ponytail: callback.handleLLMEnd calls getModelRate to compute credits.
  // providers.test.ts wipes the provider table in beforeEach, so seed
  // BEFORE each test to stay isolated from the other suite's cleanup.
  // onConflictDoUpdate — overwrite the existing row's models array,
  // since providers.test.ts may have left a stub with `models: []`.
  beforeEach(async () => {
    await db
      .insert(provider)
      .values({
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.apimart.ai/v1",
        models: [{ name: "gpt-4o-mini", enabled: true, inputPer1k: 1, outputPer1k: 3 }],
      })
      .onConflictDoUpdate({
        target: provider.id,
        set: {
          baseUrl: "https://api.apimart.ai/v1",
          models: [{ name: "gpt-4o-mini", enabled: true, inputPer1k: 1, outputPer1k: 3 }],
        },
      });
  });

  afterAll(async () => {
    for (const id of testUserIds) {
      await db.delete(user).where(eq(user.id, id));
    }
  });

  async function makeUser(roleId: "user" | "admin") {
    const id = randomUUID();
    await db.insert(user).values({ id, email: `${id}@test.local`, roleId });
    testUserIds.push(id);
    return id;
  }

  async function clearLog(userId: string) {
    await db.delete(creditUsageLog).where(eq(creditUsageLog.userId, userId));
  }

  it("handleLLMEnd records a success row with computed credits", async () => {
    const userId = await makeUser("user");
    await clearLog(userId);

    const handler = new CreditTrackingHandler();
    // LangChain auto-injects `langgraph_node` + `ls_model_name` on every
    // real LLM call. Tests pass the same final shape directly.
    // `llm` carries the ChatOpenAI instance — baseURL lives at
    // llm.kwargs.configuration.baseURL.
    const metadata = {
      userId,
      langgraph_node: "routerAgentNode",
      ls_model_name: "gpt-4o-mini",
    };
    const fakeLlm = {
      kwargs: { configuration: { baseURL: "https://api.apimart.ai/v1" } },
    };

    // handleLLMStart caches RunMeta by runId; handleLLMEnd reads from it.
    await handler.handleLLMStart(
      fakeLlm as never,
      [],
      "run-success",
      undefined,
      undefined,
      undefined,
      metadata,
    );
    await handler.handleLLMEnd(makeLlmResult({ input: 1000, output: 2000 }), "run-success");

    const rows = await db.select().from(creditUsageLog).where(eq(creditUsageLog.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("success");
    expect(rows[0].agentName).toBe("routerAgentNode");
    expect(rows[0].modelName).toBe("gpt-4o-mini");
    expect(rows[0].inputTokens).toBe(1000);
    expect(rows[0].outputTokens).toBe(2000);
    expect(Number(rows[0].credits)).toBeCloseTo(7, 4);
  });

  it("handleLLMError records an error row", async () => {
    const userId = await makeUser("user");
    await clearLog(userId);

    const handler = new CreditTrackingHandler();
    const metadata = {
      userId,
      langgraph_node: "routerAgentNode",
      ls_model_name: "gpt-4o-mini",
    };
    const fakeLlm = {
      kwargs: { configuration: { baseURL: "https://api.apimart.ai/v1" } },
    };
    await handler.handleLLMStart(
      fakeLlm as never,
      [],
      "run-error",
      undefined,
      undefined,
      undefined,
      metadata,
    );
    await handler.handleLLMError(new Error("upstream 503"), "run-error");

    const rows = await db.select().from(creditUsageLog).where(eq(creditUsageLog.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].errorMessage).toBe("upstream 503");
    expect(rows[0].inputTokens).toBe(0);
    expect(rows[0].outputTokens).toBe(0);
  });

  it("handleLLMError for QuotaExceededError does NOT record (defensive)", async () => {
    // ponytail: real quota enforcement lives in backend/model.ts's wrapper,
    // which throws BEFORE invoke/stream — so handleLLMError never fires for
    // a blocked call in practice. This test guards the bookkeeping path
    // anyway: if a QuotaExceededError ever leaks into handleLLMError, the
    // handler must skip recording (no LLM call happened, no row to write).
    const userId = await makeUser("user");
    await clearLog(userId);

    const handler = new CreditTrackingHandler();
    const metadata = {
      userId,
      langgraph_node: "routerAgentNode",
      ls_model_name: "gpt-4o-mini",
    };
    const fakeLlm = {
      kwargs: { configuration: { baseURL: "https://api.apimart.ai/v1" } },
    };
    await handler.handleLLMStart(
      fakeLlm as never,
      [],
      "run-quota",
      undefined,
      undefined,
      undefined,
      metadata,
    );
    await handler.handleLLMError(new QuotaExceededError(new Date(), 200, 200), "run-quota");

    const rows = await db.select().from(creditUsageLog).where(eq(creditUsageLog.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it("handleLLMStart for admin skips cap check entirely", async () => {
    const userId = await makeUser("admin");
    await clearLog(userId);

    const handler = new CreditTrackingHandler();
    const metadata = {
      userId,
      langgraph_node: "routerAgentNode",
      ls_model_name: "gpt-4o-mini",
    };
    const fakeLlm = {
      kwargs: { configuration: { baseURL: "https://api.apimart.ai/v1" } },
    };
    await expect(
      handler.handleLLMStart(
        fakeLlm as never,
        [],
        "run-admin",
        undefined,
        undefined,
        undefined,
        metadata,
      ),
    ).resolves.toBeUndefined();
  });
});

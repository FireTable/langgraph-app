import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { renameThread } from "@/lib/threads/queries";
import { chatModelWithoutThink } from "@/backend/model";

// Generates a short chat title from the first user message and writes it
// to the threads row. Does NOT mutate graph state — the runtime's
// generateTitle reads the title from the DB. Runs on every turn (no
// short-circuit): the LLM call is cheap relative to the agent run, and
// keeping state.title out of the graph avoids a reducer that would
// otherwise need to write through on every parallel fan-out.
//
// The graph fans out to this node in parallel with `agent` (see agent.ts).
//
// `chatModelWithoutThink.invoke()` is used (not `.stream()`) and tagged
// `nostream` so the langgraph runtime does not broadcast partial tokens
// as `messages/partial` events (useLangGraphMessages would render them as
// chat messages).
export async function renameThreadNode(
  state: { messages: BaseMessage[] },
  config: { writer?: (chunk: unknown) => void; configurable?: { thread_id?: string } },
): Promise<null | undefined> {
  const firstUserMessage = state.messages.find((m): m is HumanMessage => m instanceof HumanMessage);
  // undefined signals "didn't run" so LangGraph treats it as no-op
  if (!firstUserMessage) return undefined;

  const response = await chatModelWithoutThink.invoke(
    [
      new SystemMessage(
        `作为标题生成器，请根据提供的首轮对话内容，生成一个概括核心话题的标题。

严格遵循以下规则：
- 字数限制：总长度控制在 30 个字符以内。
- 语言一致：必须使用对话中用户主要使用的语言。
- 中立客观：不带主观色彩和语气词，提取核心动宾短语或名词。
- 绝对格式：必须且只能输出标题文本本身。绝对禁止输出任何前缀、解释、引号，不要在结尾添加句号或其他标点。`,
      ),
      firstUserMessage,
    ],
    {
      // !important: this tag will not add stream to message
      tags: ["nostream"],
    },
  );
  const trimmed = (typeof response.content === "string" ? response.content : "").trim();

  const threadId = config.configurable?.thread_id;
  if (threadId) await renameThread(threadId, trimmed);

  // null signals "ran but no state mutation" — DB is the source of truth
  return null;
}

import { type BaseMessage } from "@langchain/core/messages";

export const ROUTABLE_AGENTS = ["codeAgent", "cryptoAgent", "weatherAgent"] as const;
export type RoutableAgent = (typeof ROUTABLE_AGENTS)[number];

export type KeywordRule = string | RegExp;

export interface AgentRuleGroup {
  agent: RoutableAgent;
  rules: KeywordRule[];
}

/**
 * Priority-ordered agent keyword rules.
 * Traversed top-to-bottom. Higher priority rule groups (e.g. codeAgent)
 * take precedence to avoid false positive cross-domain misclassifications.
 */
export const AGENT_KEYWORD_RULES: AgentRuleGroup[] = [
  // -------------------------------------------------------------
  // 1. Code Agent (Highest Priority)
  // Matches: code block markdown, code writing/editing verbs,
  // data conversion actions, programming language specifiers, error stack traces.
  // -------------------------------------------------------------
  {
    agent: "codeAgent",
    rules: [
      // Markdown code block (e.g., ```ts, ```python)
      /```[a-z]*/i,
      // Explicit code writing/manipulation phrases (allows intervening words like "Python")
      /(写|编写|生成|重构|优化|运行|调试|修复)[\s\S]{0,15}(代码|脚本|程序|函数|接口|正则)/i,
      /(write|generate|refactor|run|debug|fix)[\s\S]{0,20}(code|script|function|program|regex)/i,
      // Common data format transformation actions
      /(json\s*(转|->|2)\s*csv|csv\s*(转|->|2)\s*json|base64\s*(编|解)码)/i,
      // Explicit language declaration followed by code terms
      /\b(typescript|javascript|python|golang|rust)\s+(代码|脚本|程序|函数|写法|语法)\b/i,
      // Standard runtime stack trace identifiers
      /(stack trace|typeerror|referenceerror|nullpointerexception|uncaught exception)/i,
    ],
  },

  // -------------------------------------------------------------
  // 2. Crypto Agent (Medium Priority)
  // Matches: cryptocurrency tickers, Web3/wallet concepts, market quotes, swap intent.
  // -------------------------------------------------------------
  {
    agent: "cryptoAgent",
    rules: [
      // Unambiguous crypto tickers with word boundary checks
      /\b(btc|eth|usdt|usdc|doge|shib)\b/i,
      // Explicit crypto terms
      /\b(bitcoin|ethereum|cryptocurrency|rainbowkit|coingecko)\b/i,
      "比特币",
      "以太坊",
      "加密货币",
      "数字货币",
      "币价",
      "nft holdings",
      "connect_wallet",
      // Trading / Swap phrases
      /(买|卖|换|交易|swap|buy|sell)\s*(btc|eth|usdt|sol|加密货币|代币)/i,
    ],
  },

  // -------------------------------------------------------------
  // 3. Weather Agent (Standard Priority)
  // Matches: weather forecast, temperature, air quality, precipitation, clothing guidance.
  // -------------------------------------------------------------
  {
    agent: "weatherAgent",
    rules: [
      // Chinese weather terms
      "天气",
      "天气预报",
      "气温",
      "空气质量",
      "穿衣指数",
      "aqi",
      "pm2.5",
      "摄氏度",
      "华氏度",
      // English weather terms with word boundaries
      /\b(weather|forecast|celsius|fahrenheit|air quality)\b/i,
      // Precipitation & typhoon phrases
      /(下雨|降雨量|下雪|暴雨|台风预警|出门带伞)/i,
      // Temperature queries
      /(冷不冷|热不热|今天几度|明天几度|后天几度)/i,
    ],
  },
];

export interface KeywordMatchResult {
  agent: RoutableAgent;
  matchedKey: string;
}

/**
 * Extract clean string text content from a BaseMessage.
 */
function extractTextFromMessage(message: BaseMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter(
        (part) =>
          typeof part === "object" && part !== null && (part as { type?: string }).type === "text",
      )
      .map((part) => (part as { text?: string }).text ?? "")
      .join(" ");
  }
  return "";
}

/**
 * Match a BaseMessage against the priority keyword rule groups.
 * Returns the matched target agent and the exact matched rule string.
 */
export function matchKeywordRoute(
  message: BaseMessage | null | undefined,
): KeywordMatchResult | null {
  if (!message) return null;

  const text = extractTextFromMessage(message);
  if (!text || text.trim().length === 0) return null;

  const normalizedText = text.toLowerCase();

  for (const { agent, rules } of AGENT_KEYWORD_RULES) {
    for (const rule of rules) {
      let isMatched = false;
      let matchedKeyStr = "";

      if (typeof rule === "string") {
        isMatched = normalizedText.includes(rule.toLowerCase());
        matchedKeyStr = rule;
      } else if (rule instanceof RegExp) {
        isMatched = rule.test(text);
        matchedKeyStr = rule.toString();
      }

      if (isMatched) {
        return {
          agent,
          matchedKey: matchedKeyStr,
        };
      }
    }
  }

  return null;
}

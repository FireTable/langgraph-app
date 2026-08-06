import { describe, it, expect } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { matchKeywordRoute } from "@/lib/router/keywords";

describe("matchKeywordRoute", () => {
  it("matches codeAgent for markdown code blocks", () => {
    const msg = new HumanMessage("Here is my code:\n```ts\nconst x = 1;\n```");
    const result = matchKeywordRoute(msg);
    expect(result).toEqual({
      agent: "codeAgent",
      matchedKey: "/```[a-z]*/i",
    });
  });

  it("matches codeAgent for code writing phrases", () => {
    const msg = new HumanMessage("请帮我写一段 Python 脚本处理数据");
    const result = matchKeywordRoute(msg);
    expect(result).toEqual({
      agent: "codeAgent",
      matchedKey: "/(写|编写|生成|重构|优化|运行|调试|修复)[\\s\\S]{0,15}(代码|脚本|程序|函数|接口|正则)/i",
    });
  });

  it("matches cryptoAgent for BTC price query", () => {
    const msg = new HumanMessage("What is the current BTC price?");
    const result = matchKeywordRoute(msg);
    expect(result).toEqual({
      agent: "cryptoAgent",
      matchedKey: "/\\b(btc|eth|usdt|usdc|doge|shib)\\b/i",
    });
  });

  it("matches cryptoAgent for Chinese crypto terms", () => {
    const msg = new HumanMessage("显示我的 比特币 资产行情");
    const result = matchKeywordRoute(msg);
    expect(result).toEqual({
      agent: "cryptoAgent",
      matchedKey: "比特币",
    });
  });

  it("matches weatherAgent for weather queries", () => {
    const msg = new HumanMessage("明天上海的天气预报怎么样");
    const result = matchKeywordRoute(msg);
    expect(result).toEqual({
      agent: "weatherAgent",
      matchedKey: "天气",
    });
  });

  it("returns null for generic chat messages without keywords", () => {
    const msg = new HumanMessage("你好，请和我聊聊哲学的历史发展");
    const result = matchKeywordRoute(msg);
    expect(result).toBeNull();
  });
});

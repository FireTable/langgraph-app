import { describe, it, expect } from "vitest";

import {
  CHAT_AGENT_PROMPT,
  RENAME_THREAD_PROMPT,
  ROUTER_AGENT_PROMPT,
  WEATHER_AGENT_PROMPT,
} from "@/backend/prompt/system";

describe("CHAT_AGENT_PROMPT", () => {
  it("identifies the assistant as the app's general-purpose agent", () => {
    expect(CHAT_AGENT_PROMPT).toMatch(/LangGraph App/);
  });

  it("instructs the agent to use search/fetch tools for current information", () => {
    expect(CHAT_AGENT_PROMPT).toMatch(/searchWeb/);
    expect(CHAT_AGENT_PROMPT).toMatch(/fetchUrl/);
  });

  it("tells the agent to match the user's language", () => {
    expect(CHAT_AGENT_PROMPT).toMatch(/language/i);
  });

  it("forbids the agent from handling weather questions itself", () => {
    expect(CHAT_AGENT_PROMPT).toMatch(/weather/i);
  });
});

describe("ROUTER_AGENT_PROMPT", () => {
  it("lists both routing targets", () => {
    expect(ROUTER_AGENT_PROMPT).toContain("weatherAgent");
    expect(ROUTER_AGENT_PROMPT).toContain("chatAgent");
  });

  it("specifies a JSON object output shape", () => {
    expect(ROUTER_AGENT_PROMPT).toMatch(/JSON object/i);
    expect(ROUTER_AGENT_PROMPT).toMatch(/next/i);
  });

  it("forbids the router from answering the user's question", () => {
    expect(ROUTER_AGENT_PROMPT).toMatch(/Do not answer the user's question/i);
  });
});

describe("RENAME_THREAD_PROMPT", () => {
  it("caps title length", () => {
    expect(RENAME_THREAD_PROMPT).toMatch(/30/);
  });

  it("requires language matching the conversation", () => {
    expect(RENAME_THREAD_PROMPT).toMatch(/Language/i);
  });

  it("forbids explanations and trailing punctuation", () => {
    expect(RENAME_THREAD_PROMPT).toMatch(/No explanations/i);
    expect(RENAME_THREAD_PROMPT).toMatch(/No trailing punctuation/i);
  });
});

describe("WEATHER_AGENT_PROMPT", () => {
  it("names each weather tool the sub-agent should call", () => {
    expect(WEATHER_AGENT_PROMPT).toContain("geocode_location");
    expect(WEATHER_AGENT_PROMPT).toContain("ask_location");
    expect(WEATHER_AGENT_PROMPT).toContain("get_weather");
  });

  it("forbids calling ask_location when a place is already named", () => {
    expect(WEATHER_AGENT_PROMPT).toMatch(/ask_location/);
    expect(WEATHER_AGENT_PROMPT).toMatch(/never call `geocode_location` and `ask_location`/i);
  });

  it("forbids inventing coordinates on tool failure", () => {
    expect(WEATHER_AGENT_PROMPT).toMatch(/Never invent coordinates/);
  });

  it("instructs the sub-agent to keep the final reply short", () => {
    expect(WEATHER_AGENT_PROMPT).toMatch(/ONE short sentence/);
  });

  it("forbids batching more than one tool call per turn", () => {
    expect(WEATHER_AGENT_PROMPT).toMatch(/one tool per turn/i);
  });

  it("specifies the strict order: ask_location then geocode then weather", () => {
    const order = [
      /ask_location/,
      /geocode_location/,
      /get_weather/,
    ];
    let lastSeen = -1;
    for (const pat of order) {
      const idx = WEATHER_AGENT_PROMPT.search(pat);
      expect(idx, `expected ${pat} to appear`).toBeGreaterThan(-1);
      expect(idx, `expected ${pat} to appear after the previous step`).toBeGreaterThan(lastSeen);
      lastSeen = idx;
    }
  });

  it("routes the no-place case to ask_location first", () => {
    expect(WEATHER_AGENT_PROMPT).toMatch(/no place|not.*named|did not name/i);
    const askIdx = WEATHER_AGENT_PROMPT.search(/ask_location/);
    const geocodeIdx = WEATHER_AGENT_PROMPT.search(/geocode_location/);
    expect(askIdx).toBeGreaterThan(-1);
    expect(geocodeIdx).toBeGreaterThan(-1);
    expect(askIdx).toBeLessThan(geocodeIdx);
  });
});

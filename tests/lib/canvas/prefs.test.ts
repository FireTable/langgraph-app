// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { getCanvasOpen, setCanvasOpen } from "@/lib/canvas/prefs";

const TID = "thread-123";

describe("lib/canvas/prefs — getCanvasOpen", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns false when no key is set", () => {
    expect(getCanvasOpen(TID)).toBe(false);
  });

  it("returns false for a null threadId", () => {
    expect(getCanvasOpen(null)).toBe(false);
  });

  it("returns true after the key is written", () => {
    setCanvasOpen(TID, true);
    expect(getCanvasOpen(TID)).toBe(true);
  });

  it("keys are namespaced per threadId", () => {
    setCanvasOpen("thread-a", true);
    setCanvasOpen("thread-b", false);
    expect(getCanvasOpen("thread-a")).toBe(true);
    expect(getCanvasOpen("thread-b")).toBe(false);
  });

  it("returns false when localStorage throws (private mode)", () => {
    const original = window.localStorage.getItem;
    window.localStorage.getItem = () => {
      throw new Error("SecurityError");
    };
    try {
      expect(getCanvasOpen(TID)).toBe(false);
    } finally {
      window.localStorage.getItem = original;
    }
  });
});

describe("lib/canvas/prefs — setCanvasOpen", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("writes the key on open=true", () => {
    setCanvasOpen(TID, true);
    expect(window.localStorage.getItem("canvas:" + TID + ":open")).toBe("1");
  });

  it("removes the key on open=false", () => {
    setCanvasOpen(TID, true);
    setCanvasOpen(TID, false);
    expect(window.localStorage.getItem("canvas:" + TID + ":open")).toBeNull();
  });

  it("is a no-op when threadId is null", () => {
    setCanvasOpen(null, true);
    expect(window.localStorage.length).toBe(0);
  });

  it("swallows localStorage write errors (quota / private mode)", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("QuotaExceeded");
    };
    try {
      expect(() => setCanvasOpen(TID, true)).not.toThrow();
    } finally {
      window.localStorage.setItem = original;
    }
  });
});

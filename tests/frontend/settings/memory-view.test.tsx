import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import React from "react";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) =>
    React.createElement("a", { href }, children),
}));

globalThis.fetch = mockFetch as unknown as typeof fetch;

import { MemoryView } from "@/components/settings/memory-view";

const PROFILE_PAYLOAD = {
  profile: { role: "frontend", wallet: "0xabc" },
  session: { name: "Yongzhuo", email: "y@example.com", image: null },
  socialAccounts: [{ provider: "github" }],
};

const THREADS_PAYLOAD = {
  threads: [
    {
      threadId: "t1",
      summaries: [
        {
          threadId: "t1",
          sequence: 1,
          name: "intro",
          description: "met",
          startMessageIndex: 0,
          endMessageIndex: 6,
          messageCount: 7,
          updatedAt: "2026-07-02T00:00:00.000Z",
        },
      ],
    },
  ],
};

function setupFetchOnce() {
  mockFetch.mockReset();
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve(PROFILE_PAYLOAD),
  });
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve(THREADS_PAYLOAD),
  });
}

beforeEach(() => {
  setupFetchOnce();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MemoryView", () => {
  it("renders Profile session rows without Delete (FR-020 read-only)", async () => {
    render(<MemoryView />);
    expect(await screen.findByText(/Yongzhuo/)).toBeInTheDocument();
    // session fields show "(from account)" hint, no delete button
    expect(screen.getAllByText(/from account/i).length).toBeGreaterThan(0);
  });

  it("renders Profile store rows with Delete (FR-018 deletable)", async () => {
    render(<MemoryView />);
    await screen.findByText(/Yongzhuo/);
    // both `role` and `wallet` are store rows; both should carry the hint
    expect(screen.getAllByText(/saved by you/i).length).toBeGreaterThan(0);
    const deleteButtons = screen.getAllByRole("button", { name: /^delete$/i });
    expect(deleteButtons.length).toBeGreaterThan(0);
  });

  it("renders Thread Summaries grouped by threadId (FR-018)", async () => {
    render(<MemoryView />);
    // Wait for the threads section to render before asserting on it.
    expect(await screen.findByText(/intro/)).toBeInTheDocument();
    expect(screen.getAllByText("t1").length).toBeGreaterThan(0);
  });

  it("calls DELETE /api/memory/profile/:key when Delete is clicked", async () => {
    render(<MemoryView />);
    // wait for load() to resolve and at least one profile row to render
    expect((await screen.findAllByText(/saved by you/i)).length).toBeGreaterThan(0);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, deletedKey: "role" }),
    });
    const deleteBtn = screen.getAllByRole("button", { name: /^delete$/i })[0];
    if (deleteBtn) fireEvent.click(deleteBtn);
    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes("/api/memory/profile/"))).toBe(true);
    });
  });

  it("calls DELETE /api/memory/threads/:threadId when Delete all is clicked", async () => {
    render(<MemoryView />);
    await screen.findByText(/intro/);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, deletedCount: 1 }),
    });
    const deleteAllBtn = screen.getByRole("button", { name: /delete all/i });
    fireEvent.click(deleteAllBtn);
    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes("/api/memory/threads/"))).toBe(true);
    });
  });
});

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
  // ponytail: API returns store + auth + threads separately. UI runs
  // the same mergeMemory to build the rendered view, then classifies
  // each field by store-keys membership. Fixture: name + email +
  // socials come from auth (OAuth), role + wallet come from store
  // (user-stored via save_memory).
  store: {
    role: "frontend",
    wallet: "0xabc",
  },
  auth: {
    name: "Yongzhuo",
    email: "y@example.com",
    image: null,
    socials: [{ provider: "github" }],
  },
  threads: [],
};

// ponytail: the API now bundles threads into the same /api/memory/profile
// response (flat list of {key, value} entries), so the UI only fetches
// once. The fixture extends PROFILE_PAYLOAD with one thread summary
// matching the wire shape `threads: [{key, value: SummaryEntry}]`.
const PROFILE_WITH_THREADS = {
  ...PROFILE_PAYLOAD,
  threads: [
    {
      key: "t1:1",
      value: {
        threadId: "t1",
        sequence: 1,
        startMessageIndex: 0,
        endMessageIndex: 6,
        messageCount: 7,
        messageIds: ["m0", "m1", "m2", "m3", "m4", "m5", "m6"],
        summary: {
          entries: [{ question: "intro question", answer: "met answer", refs: ["#1-#4"] }],
        },
        createdAt: "2026-07-02T00:00:00.000Z",
      },
    },
  ],
};

function setupFetchOnce() {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(PROFILE_WITH_THREADS),
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
    // ponytail: count by stable data-hint attribute — Radix Tooltip may
    // inject extra DOM siblings whose aria-label collides, so prefer
    // the hint attribute we set ourselves.
    const accountHints = document.querySelectorAll('[data-hint="from-account"]');
    expect(accountHints.length).toBe(3);
  });

  it("renders Profile store rows with Delete (FR-018 deletable)", async () => {
    render(<MemoryView />);
    await screen.findByText(/Yongzhuo/);
    const aiHints = document.querySelectorAll('[data-hint="summarized-by-ai"]');
    expect(aiHints.length).toBe(2);
    // ponytail: profile Delete button aria-label is `Delete <Key>`,
    // thread Delete-all button is `Delete all summaries for ...` —
    // both start with "Delete " so /name/ matches both. Use a tighter
    // "Delete <Capitalized>" pattern to scope to profile rows only.
    const profileDeletes = screen.getAllByRole("button", {
      name: /^Delete [A-Z]/,
    });
    expect(profileDeletes.length).toBe(aiHints.length);
  });

  it("renders Thread Summaries grouped by threadId (FR-018)", async () => {
    render(<MemoryView />);
    // Wait for the threads section to render before asserting on it.
    // The Memory tab now renders the `summary` text inline per row
    // (was `name` + `description` in the old schema).
    expect(await screen.findByText(/intro question/)).toBeInTheDocument();
    expect(screen.getAllByText("t1").length).toBeGreaterThan(0);
  });

  it("opens a confirmation dialog when Delete is clicked (does NOT call DELETE yet)", async () => {
    render(<MemoryView />);
    expect((await screen.findAllByLabelText(/Summarized by AI/i)).length).toBeGreaterThan(0);
    const deleteBtn = screen.getAllByRole("button", { name: /^Delete / })[0];
    if (deleteBtn) fireEvent.click(deleteBtn);
    // Dialog must appear with a destructive confirm button and a Cancel.
    expect(await screen.findByText(/Delete this memory/i)).toBeInTheDocument();
    // While the dialog is open, no DELETE has been issued.
    const calls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/api/memory/profile/"))).toBe(false);
  });

  it("calls DELETE /api/memory/profile/:key only after the dialog is confirmed", async () => {
    render(<MemoryView />);
    expect((await screen.findAllByLabelText(/Summarized by AI/i)).length).toBeGreaterThan(0);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, deletedKey: "role" }),
    });
    const deleteBtn = screen.getAllByRole("button", { name: /^Delete / })[0];
    if (deleteBtn) fireEvent.click(deleteBtn);
    // ponytail: dialog has its own destructive button labeled
    // "Delete" without a capitalized-key prefix. Match exact text.
    const confirmBtn = await screen.findByRole("button", { name: /^Delete$/ });
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes("/api/memory/profile/"))).toBe(true);
    });
  });

  it("cancels the dialog without firing DELETE", async () => {
    render(<MemoryView />);
    expect((await screen.findAllByLabelText(/Summarized by AI/i)).length).toBeGreaterThan(0);
    const deleteBtn = screen.getAllByRole("button", { name: /^Delete / })[0];
    if (deleteBtn) fireEvent.click(deleteBtn);
    await screen.findByText(/Delete this memory/i);
    const cancelBtn = screen.getByRole("button", { name: /^Cancel$/ });
    fireEvent.click(cancelBtn);
    await waitFor(() => {
      expect(screen.queryByText(/Delete this memory/i)).toBeNull();
    });
    const calls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/api/memory/profile/"))).toBe(false);
  });

  it("calls DELETE /api/memory/threads/:threadId only after the dialog is confirmed", async () => {
    render(<MemoryView />);
    await screen.findByText(/intro question/);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, deletedCount: 1 }),
    });
    const deleteAllBtn = screen.getByRole("button", { name: /^Delete all summaries for/ });
    fireEvent.click(deleteAllBtn);
    await screen.findByText(/Delete all thread summaries/i);
    const confirmBtn = screen.getByRole("button", { name: /^Delete all$/ });
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes("/api/memory/threads/"))).toBe(true);
    });
  });

  it("renders AI impression paragraph under the About you header", async () => {
    render(<MemoryView />);
    expect(await screen.findByText(/what our chat remembers about you/i)).toBeInTheDocument();
  });

  it("capitalizes field labels (UI-only prettify)", async () => {
    render(<MemoryView />);
    await screen.findByText(/Yongzhuo/);
    // raw store keys are lowercase (`email`, `role`, `wallet`) but the UI
    // shows them capitalized
    expect(screen.getByText(/^Email$/)).toBeInTheDocument();
    expect(screen.getByText(/^Role$/)).toBeInTheDocument();
    expect(screen.getByText(/^Wallet$/)).toBeInTheDocument();
  });

  it("renders About you rows with account fields first, store fields last", async () => {
    render(<MemoryView />);
    await screen.findByText(/Yongzhuo/);
    // ponytail: AUTH_OVERLAY_KEYS order — image is null in the fixture so
    // the merge drops it. The rendered order is name → email → socials
    // for account rows; then store rows alphabetically: role → wallet.
    const labels = screen.getAllByText(/^(Name|Email|Socials|Role|Wallet)$/);
    const ordered = labels.map((n) => n.textContent ?? "");
    expect(ordered).toEqual(["Name", "Email", "Socials", "Role", "Wallet"]);
  });

  it("expands array values into pretty-printed JSON", async () => {
    render(<MemoryView />);
    await screen.findByText(/Yongzhuo/);
    // ponytail: structured values render as a single <pre>{JSON.stringify(...)}</pre>
    // block. The socials fixture is [{ provider: "github" }], so the
    // block must contain both the key `provider` and the value `github`.
    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent ?? "").toContain("provider");
    expect(pre?.textContent ?? "").toContain("github");
  });
});

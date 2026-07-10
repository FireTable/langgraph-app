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
// response (flat list of {key, value, threadTitle} entries), so the UI
// only fetches once. The fixture extends PROFILE_PAYLOAD with two
// thread summaries (sequence 1 + 2 of the same thread) matching the
// wire shape so we can exercise the grouping + compression nesting.
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
      threadTitle: "Weather chat",
    },
    {
      key: "t1:2",
      value: {
        threadId: "t1",
        sequence: 2,
        startMessageIndex: 7,
        endMessageIndex: 9,
        messageCount: 3,
        messageIds: ["m7", "m8", "m9"],
        summary: {
          entries: [{ question: "follow-up", answer: "follow-up answer", refs: ["#8-#9"] }],
        },
        createdAt: "2026-07-02T01:00:00.000Z",
      },
      threadTitle: "Weather chat",
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

// ponytail: thread rows default to collapsed. Tests that need to
// read Q&A text inside a thread first call this helper to flip the
// toggle, then await the first Q&A line. Targets the toggle by
// data-hint (not aria-label) because the aria-label embeds the
// thread title, which differs across fixtures (real title vs raw
// threadId fallback).
//
// As of the mobile UI batch: SummaryContent is rendered into two
// DOM slots (mobile `md:hidden` copy + desktop `hidden md:block`
// copy) so the same Q&A text shows up twice in the rendered DOM
// in jsdom. findAllByText is used instead of findByText for the
// post-click check.
async function expandFirstThread() {
  const toggle = await waitFor(() => {
    const el = document.querySelector('[data-hint="thread-collapse"]');
    if (!el || !(el instanceof HTMLButtonElement)) throw new Error("no thread-collapse toggle");
    return el;
  });
  fireEvent.click(toggle);
  await waitFor(() => {
    expect(screen.queryAllByText(/intro question/).length).toBeGreaterThan(0);
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
  it("renders a skeleton layout matching About-you + Thread-summaries while loading", async () => {
    // ponytail: defer the initial GET so we can observe the pre-data
    // skeleton — the same mockImplementation pattern as the delete
    // tests (mockImplementationOnce would queue the pending promise
    // as the first fetch response and the component would never
    // resolve out of the loading state).
    let resolveProfile!: (value: Response) => void;
    const pendingProfile = new Promise<Response>((resolve) => {
      resolveProfile = resolve;
    });
    mockFetch.mockReset();
    mockFetch.mockImplementationOnce(() => pendingProfile);

    render(<MemoryView />);
    // ponytail: count by `data-slot="skeleton"` (the shadcn primitive
    // marker) instead of role/class strings — those shift with copy
    // edits. The skeleton mirrors both sections, so we expect many
    // blocks but the exact count is loose to keep the test durable.
    const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(10);
    // ponytail: the real "About you" intro copy must NOT be present
    // during loading — its presence means the skeleton didn't render
    // and the real layout leaked through.
    expect(screen.queryByText(/what our chat remembers/i)).toBeNull();

    resolveProfile({
      ok: true,
      status: 200,
      json: () => Promise.resolve(PROFILE_WITH_THREADS),
    } as Response);
    expect(await screen.findByText(/Yongzhuo/)).toBeInTheDocument();
    // ponytail: once the data arrives the skeleton leaves the DOM —
    // count goes back to zero. (TooltipProvider may inject a hidden
    // portal, but Skeleton is plain <div>s so querySelectorAll is exact.)
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
  });

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
    expect(await screen.findByText("Weather chat")).toBeInTheDocument();
    expect(screen.getAllByText("t1").length).toBeGreaterThan(0);
    // ponytail: rows default to collapsed. Expand to verify the Q&A
    // body renders under the thread header (not the meta line).
    await expandFirstThread();
    // SummaryContent is rendered into mobile + desktop DOM slots, so
    // the Q&A text shows up twice in jsdom — assert presence, not
    // exact count.
    expect(screen.queryAllByText(/intro question/).length).toBeGreaterThan(0);
  });

  it("renders each compression as its own sub-row with iteration label + timestamp", async () => {
    render(<MemoryView />);
    // ponytail: rows default to collapsed. Expand first, then the
    // Summary · N labels + per-summary Q&A both render.
    await expandFirstThread();
    // SummaryContent is rendered into mobile + desktop slots; the
    // per-summary text shows up twice in jsdom, so assert >= 1.
    expect(screen.queryAllByText(/Summary · 1/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Summary · 2/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/intro question/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/follow-up/).length).toBeGreaterThan(0);
  });

  it("falls back to the raw threadId when threadTitle is null", async () => {
    // ponytail: threads that pre-date the rename path (or where the
    // path never ran) still display — the title slot is the raw id
    // instead of "New chat". The same id rendered TWICE (header label
    // + meta line) would be visual noise, so when title is null the
    // meta line is suppressed and the id shows exactly once.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ...PROFILE_WITH_THREADS,
          threads: PROFILE_WITH_THREADS.threads.map((t) => ({ ...t, threadTitle: null })),
        }),
    });
    render(<MemoryView />);
    await expandFirstThread();
    expect(screen.queryAllByText(/Summary · 1/).length).toBeGreaterThan(0);
    // ponytail: with no title, `t1` shows once as the header fallback
    // and the meta line under it is suppressed (no duplicate id).
    // When title IS present (the other tests) it shows twice — once as
    // title, once as muted meta.
    expect(screen.getByText("t1")).toBeInTheDocument();
    expect(screen.queryAllByText("t1")).toHaveLength(1);
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
    await expandFirstThread();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, deletedCount: 1 }),
    });
    const deleteAllBtn = screen.getByRole("button", { name: /^Delete this thread summaries for/ });
    fireEvent.click(deleteAllBtn);
    await screen.findByText(/Delete this thread summaries/i);
    const confirmBtn = screen.getByRole("button", { name: /^Delete$/ });
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes("/api/memory/threads/"))).toBe(true);
    });
  });

  it("disables both buttons and shows a spinner on the confirm while DELETE is in flight (profile)", async () => {
    // ponytail: defer the DELETE so we can observe the in-flight state
    // — the destructive button must show "Deleting…" + aria-busy, and
    // Cancel must be disabled too (otherwise the user can race the
    // dialog closed while the request is still settling).
    //
    // Use mockImplementation (not Once) so the initial GET /api/memory/profile
    // still resolves — using Once here would queue the pending promise as
    // the FIRST fetch response and the component would stay on "Loading…".
    let resolveDelete!: (value: Response) => void;
    const pendingDelete = new Promise<Response>((resolve) => {
      resolveDelete = resolve;
    });
    mockFetch.mockImplementation((_url, options) => {
      if (options?.method === "DELETE") return pendingDelete;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(PROFILE_WITH_THREADS),
      });
    });

    render(<MemoryView />);
    await screen.findByText(/Yongzhuo/);
    fireEvent.click(screen.getAllByRole("button", { name: /^Delete / })[0]);
    await screen.findByText(/Delete this memory/i);

    const cancelBtn = screen.getByRole("button", { name: /^Cancel$/ });
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));

    // ponytail: confirm label swaps to "Deleting…" and gets aria-busy
    // so screen readers announce the in-flight state. Both buttons are
    // disabled — clicking Cancel mid-flight would close the dialog and
    // orphan the DELETE, which the user can't observe.
    const busyBtn = await screen.findByRole("button", { name: /Deleting/ });
    expect(busyBtn).toBeDisabled();
    expect(busyBtn).toHaveAttribute("aria-busy", "true");
    expect(cancelBtn).toBeDisabled();

    // ponytail: resolve the DELETE; the post-delete load() GET falls
    // through to the non-DELETE branch above and returns PROFILE_WITH_THREADS.
    resolveDelete({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, deletedKey: "role" }),
    } as Response);
    await waitFor(() => {
      expect(screen.queryByText(/Delete this memory/i)).toBeNull();
    });
  });

  it("disables both buttons and shows a spinner on the confirm while DELETE is in flight (thread)", async () => {
    let resolveDelete!: (value: Response) => void;
    const pendingDelete = new Promise<Response>((resolve) => {
      resolveDelete = resolve;
    });
    mockFetch.mockImplementation((_url, options) => {
      if (options?.method === "DELETE") return pendingDelete;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(PROFILE_WITH_THREADS),
      });
    });

    render(<MemoryView />);
    await expandFirstThread();
    // mobile + desktop each render a Delete (different DOM positions);
    // either one opens the same dialog.
    const threadDeleteBtns = screen.getAllByRole("button", {
      name: /^Delete this thread summaries for/,
    });
    fireEvent.click(threadDeleteBtns[0]);
    await screen.findByText(/Delete this thread summaries/i);

    const cancelBtn = screen.getByRole("button", { name: /^Cancel$/ });
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));

    const busyBtn = await screen.findByRole("button", { name: /Deleting/ });
    expect(busyBtn).toBeDisabled();
    expect(busyBtn).toHaveAttribute("aria-busy", "true");
    expect(cancelBtn).toBeDisabled();

    resolveDelete({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, deletedCount: 1 }),
    } as Response);
    await waitFor(() => {
      expect(screen.queryByText(/Delete this thread summaries/i)).toBeNull();
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

  // ponytail: per-thread collapse — each thread header owns its own
  // chevron toggle. Defaults to COLLAPSED so a long list of
  // past threads renders as scannable single-line headers; clicking
  // expands the thread to its Q&A blocks.
  it("renders each thread header with a collapse toggle (default collapsed)", async () => {
    render(<MemoryView />);
    const expandToggle = await screen.findByRole("button", {
      name: /Expand Weather chat/i,
    });
    expect(expandToggle).toHaveAttribute("aria-expanded", "false");
    // ponytail: while collapsed, the Q&A bodies are hidden but the
    // header line still renders.
    expect(screen.queryByText(/intro question/)).toBeNull();
    expect(screen.queryByText(/follow-up/)).toBeNull();
    expect(screen.getByText("Weather chat")).toBeInTheDocument();
  });

  it("expands the thread to show its Q&A summaries when clicked", async () => {
    render(<MemoryView />);
    const toggle = await screen.findByRole("button", {
      name: /Expand Weather chat/i,
    });
    fireEvent.click(toggle);

    // ponytail: the thread's Q&A bodies appear, but the header
    // (title + threadId meta + Delete) stays as it was.
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // SummaryContent renders into mobile + desktop DOM slots — the
    // same Q&A text shows up twice in the rendered tree. Assert
    // presence (≥ 1) rather than the historical getByText contract.
    expect(screen.queryAllByText(/intro question/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/follow-up/).length).toBeGreaterThan(0);

    // ponytail: the toggle's aria-label flips to "Collapse …" so the
    // screen-reader announcement describes the next-click action.
    expect(screen.getByRole("button", { name: /Collapse Weather chat/i })).toBeInTheDocument();
  });

  it("collapses an expanded thread when its toggle is clicked again", async () => {
    render(<MemoryView />);
    const expandToggle = await screen.findByRole("button", {
      name: /Expand Weather chat/i,
    });
    fireEvent.click(expandToggle);
    // SummaryContent renders twice (mobile + desktop DOM slots); Q&A
    // text shows up in both. Assert presence rather than single match.
    expect(screen.queryAllByText(/intro question/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Collapse Weather chat/i }));
    expect(expandToggle).toHaveAttribute("aria-expanded", "false");
    // Closed → both SummaryContent copies hide, neither retains
    // `intro question`. queryByText (singular) still works when
    // nothing matches.
    expect(screen.queryByText(/intro question/)).toBeNull();
  });

  it("does not render thread-collapse toggles when there are no thread summaries", async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ...PROFILE_PAYLOAD, threads: [] }),
    });
    render(<MemoryView />);
    expect(await screen.findByText(/No thread summaries yet/i)).toBeInTheDocument();
    // ponytail: empty state owns the section — no rows to toggle.
    expect(screen.queryAllByRole("button", { name: /Expand /i })).toHaveLength(0);
  });

  // ponytail: expand/collapse is animated, not a hard show/hide.
  // Radix Collapsible marks the body with data-state so CSS
  // transitions can interpolate height from 0 to auto.
  it("animates the thread body on expand and collapse", async () => {
    render(<MemoryView />);
    const toggle = await waitFor(() => {
      const el = document.querySelector('[data-hint="thread-collapse"]');
      if (!el || !(el instanceof HTMLButtonElement)) throw new Error("no thread-collapse toggle");
      return el;
    });
    // ponytail: Radix Collapsible renders the body with data-state
    // so the user sees a smooth height transition instead of a
    // jarring pop. Closed by default.
    const body = await waitFor(() => {
      const el = document.querySelector('[data-slot="thread-body"]');
      if (!el) throw new Error("no thread body");
      return el;
    });
    expect(body.getAttribute("data-state")).toBe("closed");

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(body.getAttribute("data-state")).toBe("open");
    });

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(body.getAttribute("data-state")).toBe("closed");
    });
  });

  // ─── mobile UI batch 1 — regression tests ──────────────────────────
  // Tests below pin the responsive layout decisions for issues #21/26.
  // They match via className (Tailwind responsive prefixes) so a
  // regression that drops the responsive utility surfaces here.

  it("mobile (#21): Profile store Delete button is full-width + col-span-2 (lands below the value)", async () => {
    render(<MemoryView />);
    await screen.findByText(/Yongzhuo/);
    // ponytail: store rows are tagged with data-hint="summarized-by-ai"
    // and have a Delete button whose aria-label starts with "Delete "
    // followed by a Capitalized key (vs the thread-summary Delete
    // which is "Delete this thread summaries for ...").
    const deletes = screen.getAllByRole("button", { name: /^Delete [A-Z]/ });
    expect(deletes.length).toBeGreaterThan(0);
    for (const btn of deletes) {
      const cls = btn.className;
      expect(cls).toContain("w-full");
      expect(cls).toContain("col-span-2");
      // ponytail: desktop should revert to inline col 3 + auto width.
      expect(cls).toContain("md:col-span-1");
      expect(cls).toContain("md:w-auto");
    }
  });

  it("mobile (#21): Thread-summarize Delete button is full-width on mobile + w-auto at md+", async () => {
    render(<MemoryView />);
    await screen.findByText("Weather chat");
    await expandFirstThread();
    const btn = screen.getByRole("button", { name: /^Delete this thread summaries for/ });
    expect(btn.className).toContain("w-full");
    expect(btn.className).toContain("md:w-auto");
  });

  it("mobile (#21): Thread body is rendered twice (mobile `md:hidden` copy + desktop `hidden md:block` copy), one per breakpoint", async () => {
    // ponytail: the SummaryContent element is conditionally placed
    // by media query — only one copy is visible at any viewport,
    // but the React tree has both (they share the parent <Collapsible>
    // `open` prop, so the body animates consistently). In jsdom
    // both copies are in the DOM regardless of media query.
    render(<MemoryView />);
    await screen.findByText("Weather chat");
    const bodies = document.querySelectorAll('[data-slot="thread-body"]');
    // PROFILE_WITH_THREADS has exactly one thread, so 2 copies total.
    expect(bodies.length).toBe(2);
    // ponytail: the mobile copy sits inside an md:hidden ancestor,
    // the desktop one inside a hidden md:block ancestor.
    const mobileAncestor = (bodies[0] as HTMLElement | null)?.closest(".md\\:hidden");
    const desktopAncestor = (bodies[1] as HTMLElement | null)?.closest(".hidden.md\\:block");
    expect(mobileAncestor).not.toBeNull();
    expect(desktopAncestor).not.toBeNull();
  });

  it("mobile (#26): Dialog footer is right-aligned on mobile (items-end, no items-start)", async () => {
    render(<MemoryView />);
    await screen.findByText(/Yongzhuo/);
    const profileDelete = screen.getAllByRole("button", { name: /^Delete [A-Z]/ })[0];
    if (profileDelete) fireEvent.click(profileDelete);
    await screen.findByText(/Delete this memory/i);
    const footer = document.querySelector('[data-slot="dialog-footer"]');
    expect(footer).not.toBeNull();
    const cls = footer?.className ?? "";
    expect(cls).toContain("items-end");
    // ponytail: items-stretch is the flex default; items-start was
    // the v1 fix, items-end the v2 fix. Guard against reverting.
    expect(cls).not.toContain("items-start");
  });

  it("mobile (#26): Profile dialog Cancel + Delete buttons are full-width on mobile, auto on md+", async () => {
    render(<MemoryView />);
    await screen.findByText(/Yongzhuo/);
    const profileDelete = screen.getAllByRole("button", { name: /^Delete [A-Z]/ })[0];
    if (profileDelete) fireEvent.click(profileDelete);
    await screen.findByText(/Delete this memory/i);
    const cancel = screen.getByRole("button", { name: /^Cancel$/ });
    const confirm = screen.getByRole("button", { name: /^Delete$/ });
    for (const btn of [cancel, confirm]) {
      const cls = btn.className;
      expect(cls).toContain("w-full");
      expect(cls).toContain("md:w-auto");
    }
  });

  it("mobile (#26): Thread dialog Cancel + Delete buttons are full-width on mobile, auto on md+", async () => {
    render(<MemoryView />);
    await screen.findByText("Weather chat");
    await expandFirstThread();
    const deleteBtn = screen.getByRole("button", { name: /^Delete this thread summaries for/ });
    fireEvent.click(deleteBtn);
    await screen.findByText(/Delete this thread summaries/i);
    const cancel = screen.getByRole("button", { name: /^Cancel$/ });
    const confirm = screen.getByRole("button", { name: /^Delete$/ });
    for (const btn of [cancel, confirm]) {
      const cls = btn.className;
      expect(cls).toContain("w-full");
      expect(cls).toContain("md:w-auto");
    }
  });
});

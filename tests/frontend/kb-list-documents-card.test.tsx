import "@/tests/frontend/setup";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

import { KbListDocumentsToolUI } from "@/components/tool-ui/kb/list-documents-card";
import type {
  ListDocResult,
  ListDocumentsDoc,
  ListDocumentsFolder,
} from "@/components/tool-ui/kb/types";

// ponytail: KbListDocumentsToolUI is a ToolCallMessagePartComponent
// (class-style prop union) — the SDK's full prop shape is wider
// than this test needs, so we pass a structural cast and the
// runtime contract is what we exercise.
const baseProps = {
  type: "tool-call" as const,
  toolCallId: "tc-list",
  toolName: "list_documents",
  args: {},
  argsText: "{}",
  status: { type: "complete" as const },
  addResult: () => {},
  resume: () => {},
  respondToApproval: () => {},
};

function makeDoc(folderId: string, i: number): ListDocumentsDoc {
  return {
    id: `d-${folderId}-${i}`,
    title: `${folderId}-doc-${i + 1}.pdf`,
    status: i % 3 === 0 ? "failed" : "success",
    errorMessage: i % 3 === 0 ? "OCR timed out" : null,
    createdAt: "2026-07-15T10:30:00.000Z",
    totalPages: 10,
    successPages: 8,
    failedPages: 2,
    parsingPages: 0,
    pendingPages: 0,
    totalChunks: 24,
    successChunks: 24,
    failedChunks: 0,
    pendingChunks: 0,
    parsingChunks: 0,
  };
}

function makeFolder(id: string, name: string, docCount: number): ListDocumentsFolder {
  return { id, name, documents: Array.from({ length: docCount }, (_, i) => makeDoc(id, i)) };
}

function renderCard(result: ListDocResult | undefined) {
  return render(
    <TooltipProvider delayDuration={0}>
      <KbListDocumentsToolUI
        {...baseProps}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result={result as any}
      />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("KbListDocumentsToolUI", () => {
  it("shows the loading state when no result is present", () => {
    renderCard(undefined);
    expect(screen.getByText("Listing KB documents")).toBeTruthy();
  });

  it("renders each folder as a labelled section with the original (non-uppercased) name", () => {
    const result: ListDocResult = {
      folders: [makeFolder("f1", "ArcBlock", 2), makeFolder("f2", "Research", 1)],
      total: 3,
      empty: false,
    };
    renderCard(result);
    // ponytail: the chat card keeps the user's original folder
    // casing ("ArcBlock", not "ARCBLOCK"). Title Case is only
    // applied to the LLM-facing `content` string, not the visible
    // header — the header is the source of truth.
    expect(screen.getByText(/^ArcBlock$/)).toBeTruthy();
    expect(screen.getByText(/^Research$/)).toBeTruthy();
  });

  it("renders a per-doc createdAt date", () => {
    const result: ListDocResult = {
      folders: [makeFolder("f1", "Attachments", 1)],
      total: 1,
      empty: false,
    };
    renderCard(result);
    const list = screen.getAllByRole("list")[0];
    const item = within(list).getByRole("listitem");
    // ponytail: <time dateTime="…"> carries the full ISO, the
    // visible text is the formatted locale date. Asserting both
    // means a refactor that drops the dateTime attribute would
    // surface as a test failure.
    const time = within(item).getByRole("time");
    expect(time.getAttribute("datetime")).toBe("2026-07-15T10:30:00.000Z");
    expect(time.textContent).toMatch(/2026/);
  });

  it("collapses the whole folder when the header is clicked, and re-expands on a second click", () => {
    const result: ListDocResult = {
      folders: [makeFolder("f1", "Big Folder", 5)],
      total: 5,
      empty: false,
    };
    renderCard(result);
    // ponytail: clicking the folder header collapses the whole
    // section (no docs visible), independent of the per-folder
    // "Show more" button. A 5-doc folder with the header
    // collapsed shows 0 docs even though VISIBLE_DOCS_PER_FOLDER=3.
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Big Folder/ }));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Big Folder/ }));
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  it("shows the first 3 docs per folder and a Show more button when there are more", () => {
    const result: ListDocResult = {
      folders: [makeFolder("f1", "Big Folder", 5)],
      total: 5,
      empty: false,
    };
    renderCard(result);
    const list = screen.getAllByRole("list")[0];
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /Show more/ })).toBeTruthy();
  });

  it("expands the folder's docs to show every one when Show more is clicked", () => {
    const result: ListDocResult = {
      folders: [makeFolder("f1", "Big Folder", 5)],
      total: 5,
      empty: false,
    };
    renderCard(result);
    // ponytail: with Radix Collapsible, the extra docs are in a
    // second <ul> inside CollapsibleContent (so the height animates
    // in/out). Count listitems across all <ul>s on the page — the
    // head list always has 3, the tail list has the rest when
    // expanded.
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByRole("button", { name: /Show less/ })).toBeTruthy();
  });

  it("renders doc + chunks status badges per doc", () => {
    const result: ListDocResult = {
      // i=1 is the "success" doc — makeDoc uses i%3===0 for failed,
      // so the first doc (i=0) is the failed one. Use 4 docs so
      // both success + failed badges are visible.
      folders: [makeFolder("f1", "Attachments", 4)],
      total: 4,
      empty: false,
    };
    renderCard(result);
    // ponytail: mirror the Settings → KB DocRow — every doc shows
    // its page-level (DocStatusBadge) and chunk-level
    // (ChunksStatusBadge) status. i=1 (success) renders "Ready" +
    // "Indexed"; i=0/2 (failed) renders "Failed" + "Not Indexed".
    expect(screen.getAllByText("Ready").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Indexed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Failed").length).toBeGreaterThanOrEqual(1);
  });

  it("shows the empty state when no folders have any documents", () => {
    const result: ListDocResult = {
      folders: [{ id: "f-empty", name: "Empty Folder", documents: [] }],
      total: 0,
      empty: true,
    };
    renderCard(result);
    expect(screen.getByText("KB is empty")).toBeTruthy();
  });
});

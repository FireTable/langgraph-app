import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { TOAST_DESCRIPTION_CLASS, getModeInfo, type ReprocessMode } from "./helpers";
import { KbDocument, KbFolder } from "./types";

export function DocDeleteDialog({
  doc,
  open,
  onOpenChange,
  onDeleted,
}: {
  doc: KbDocument;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/kb/documents/${doc.id}`, { method: "DELETE" });
      if (res.status === 204) {
        toast.success("Document deleted", {
          descriptionClassName: TOAST_DESCRIPTION_CLASS,
          description: `「${doc.title}」was removed from this folder.`,
        });
        onDeleted();
        return;
      }
      if (res.status === 404) {
        setError("Already deleted");
        return;
      }
      setError(`Failed (${res.status})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [doc.id, onDeleted]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setError(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete document?</DialogTitle>
          <DialogDescription>
            <p>
              This permanently removes <span className="font-medium">{doc.title}</span> and:
            </p>
            <ol className="mt-2 list-decimal pl-5 space-y-1">
              <li>The document row + all parsed chunks (embeddings, BM25 index, entity graph)</li>
              <li>The observability run history for this doc</li>
              <li>The standalone ingestion thread record (LangGraph metadata)</li>
            </ol>
            <p className="text-muted-foreground mt-2 text-xs">
              Source PDF + rendered page PNGs stay in R2 until the v3 retention sweep. Raw
              observability spans + LangGraph checkpoint state are kept by retention.
            </p>
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <DialogFooter>
          <Button
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            className="w-full sm:w-auto"
            onClick={() => void submit()}
            disabled={submitting}
            variant="destructive"
          >
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DocReprocessDialog({
  doc,
  open,
  onOpenChange,
  onReprocessed,
}: {
  doc: KbDocument;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReprocessed: () => void;
}) {
  const [mode, setMode] = useState<ReprocessMode>("full");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasPages = !!(
    (doc.pages && doc.pages.length > 0) ||
    (doc.totalPages !== undefined && doc.totalPages > 0)
  );

  const totalPages = doc.pages ? doc.pages.length : (doc.totalPages ?? 0);
  const failedPagesCount = doc.pages
    ? doc.pages.filter((p) => !!p.errorMessage || !(p.markdown ?? "").trim()).length
    : (doc.failedPages ?? 0);

  const hasUsableMarkdown = doc.pages
    ? doc.pages.some((p) => (p.markdown ?? "").trim().length > 0)
    : totalPages > failedPagesCount;

  const hasFailedPages = failedPagesCount > 0;

  const isChunksOnlyDisabled = !hasPages || !hasUsableMarkdown;
  const isRetryFailedDisabled = !hasPages || !hasFailedPages;

  // ponytail: retryFailedChunks only makes sense once the doc
  // reached a terminal indexing state. failedChunks comes from the
  // doc-list endpoint aggregation, so we gate on it being
  // populated. Disabled when 0 failed chunks — picking it would be
  // a wasted API call.
  const hasFailedChunks = (doc.failedChunks ?? 0) > 0;
  const isRetryFailedChunksDisabled = doc.status !== "success" || !hasFailedChunks;

  useEffect(() => {
    if (open) {
      setMode("full");
      setError(null);
    }
  }, [open]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/kb/documents/${doc.id}/reprocess?mode=${mode}`, {
        method: "POST",
      });
      if (res.status === 202) {
        let toastTitle = "Reprocess queued";
        let toastDesc = `「${doc.title}」is re-running OCR + chunking. Old chunks were cleared.`;
        if (mode === "chunksOnly") {
          toastTitle = "Rechunks queued";
          toastDesc = `「${doc.title}」- skipping OCR, rebuilding chunks from the cached pages. doc row stays Ready.`;
        } else if (mode === "retryFailed") {
          toastTitle = "Retry queued";
          toastDesc = `「${doc.title}」- retrying failed pages, then rebuilding chunks.`;
        } else if (mode === "retryFailedChunks") {
          toastTitle = "Chunk retry queued";
          toastDesc = `「${doc.title}」- re-running entity extraction on the failed chunks only. Successful chunks and the doc status stay untouched.`;
        }

        toast.info(toastTitle, {
          descriptionClassName: TOAST_DESCRIPTION_CLASS,
          description: toastDesc,
        });
        onReprocessed();
        return;
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { code?: string; reason?: string };
        if (body.code === "NOT_READY") {
          setError(
            "This option is not available — pages haven't been extracted yet. Pick 'Full re-run' first.",
          );
          return;
        }
        const msg =
          body.code === "ATTACHMENT_MISSING"
            ? "Source attachment is missing — re-upload the file instead."
            : body.code === "PROCESSING"
              ? "Already processing — try again when the row settles."
              : `Server rejected: ${body.code ?? res.status}`;
        setError(msg);
        return;
      }
      if (res.status === 404) {
        setError("Document no longer exists.");
        return;
      }
      setError(`Failed (${res.status})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [doc.id, doc.title, mode, onReprocessed]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setError(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reprocess document?</DialogTitle>
          <DialogDescription>
            <span className="font-medium">{doc.title}</span> - existing chunks are wiped before
            re-running. Choose a reprocess mode.
          </DialogDescription>
        </DialogHeader>

        <fieldset disabled={submitting} className="space-y-2" aria-label="Reprocess mode">
          {(
            [
              {
                value: "full",
                disabled: false,
                reason: "",
              },
              {
                value: "chunksOnly",
                disabled: isChunksOnlyDisabled,
                reason: "No pages cache",
              },
              {
                value: "retryFailed",
                disabled: isRetryFailedDisabled,
                reason: "No failed pages",
              },
              {
                value: "retryFailedChunks",
                disabled: isRetryFailedChunksDisabled,
                reason: doc.status !== "success" ? "Doc not indexed yet" : "No failed chunks",
              },
            ] satisfies Array<{ value: ReprocessMode; disabled: boolean; reason: string }>
          ).map(({ value, disabled, reason }) => {
            const { title, description } = getModeInfo(value);
            return (
              <label
                key={value}
                className={cn(
                  "flex items-start gap-3 rounded-md border px-3 py-2.5 transition-colors",
                  disabled ? "opacity-50 cursor-not-allowed bg-muted/10" : "cursor-pointer",
                  !disabled && mode === value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/40",
                )}
              >
                <input
                  type="radio"
                  name="reprocess-mode"
                  value={value}
                  checked={mode === value}
                  disabled={disabled}
                  onChange={() => setMode(value)}
                  className="mt-0.5 size-3.5 shrink-0 accent-foreground disabled:cursor-not-allowed"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium leading-tight flex items-center justify-between">
                    <span>{title}</span>
                    {disabled && (
                      <span className="text-[9px] font-medium text-muted-foreground border px-1 rounded bg-muted/30">
                        {reason}
                      </span>
                    )}
                  </div>
                  <div className="text-muted-foreground text-[11px] leading-snug mt-0.5">
                    {description}
                  </div>
                </div>
              </label>
            );
          })}
        </fieldset>

        {error && <p className="text-destructive text-xs">{error}</p>}
        <DialogFooter>
          <Button
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button className="w-full sm:w-auto" onClick={() => void submit()} disabled={submitting}>
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : mode === "chunksOnly" ? (
              "Rebuild chunks"
            ) : mode === "retryFailed" ? (
              "Retry failed"
            ) : mode === "retryFailedChunks" ? (
              "Retry chunks"
            ) : (
              "Reprocess"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FolderDeleteDialog({
  folder,
  onOpenChange,
  onDeleted,
}: {
  folder: KbFolder | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [folder]);

  const submit = useCallback(async () => {
    if (!folder) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/kb/folders/${folder.id}`, { method: "DELETE" });
      if (res.status === 204) {
        toast.success("Folder deleted", {
          descriptionClassName: TOAST_DESCRIPTION_CLASS,
          description: `「${folder.name}」was removed. Documents inside were kept.`,
        });
        onDeleted();
        return;
      }
      if (res.status === 404) {
        toast.success("Folder deleted", {
          descriptionClassName: TOAST_DESCRIPTION_CLASS,
          description: `「${folder.name}」was already removed.`,
        });
        onDeleted();
        return;
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { docCount?: number };
        setError(
          `Folder still has ${body.docCount ?? "some"} document${body.docCount === 1 ? "" : "s"} — delete them first.`,
        );
        return;
      }
      setError(`Failed (${res.status})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [folder, onDeleted]);

  return (
    <Dialog
      open={folder !== null}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setError(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete folder?</DialogTitle>
          <DialogDescription>
            This permanently removes the <span className="font-medium">{folder?.name}</span> folder.
            Folders that still contain documents can&apos;t be deleted — empty the folder first.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <DialogFooter>
          <Button
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            className="w-full sm:w-auto"
            onClick={() => void submit()}
            disabled={submitting}
            variant="destructive"
          >
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FolderNameDialog({
  mode,
  folder,
  open,
  onOpenChange,
  onCreated,
  onSaved,
}: {
  mode: "create" | "edit";
  folder: KbFolder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (folder: KbFolder) => void;
  onSaved?: (folder: KbFolder) => void;
}) {
  const [name, setName] = useState(folder?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(folder?.name ?? "");
      setError(null);
    }
  }, [open, folder?.name, folder?.id]);

  const submit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "create") {
        const res = await fetch("/api/kb/folders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        if (res.status === 201) {
          const body = (await res.json()) as { folder: KbFolder };
          onCreated?.(body.folder);
          setName("");
          onOpenChange(false);
          return;
        }
        if (res.status === 409) {
          setError("A folder with this name already exists");
          return;
        }
        setError(`Failed (${res.status})`);
      } else {
        if (!folder) {
          setError("No folder to edit");
          return;
        }
        const res = await fetch(`/api/kb/folders/${folder.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        if (res.status === 200) {
          const body = (await res.json()) as { folder: KbFolder };
          onSaved?.(body.folder);
          onOpenChange(false);
          return;
        }
        if (res.status === 409) {
          setError("A folder with this name already exists");
          return;
        }
        setError(`Failed (${res.status})`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [mode, folder, name, onCreated, onSaved, onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setError(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New folder" : "Edit folder"}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Group your knowledge base documents by topic or project."
              : "Rename this folder. Documents inside keep their content."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="kb-folder-name">Name</Label>
          <Input
            id="kb-folder-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Project Research"
            maxLength={64}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && !submitting) void submit();
            }}
          />
          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            className="w-full sm:w-auto"
            onClick={() => void submit()}
            disabled={submitting || !name.trim()}
          >
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : mode === "create" ? (
              "Create"
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

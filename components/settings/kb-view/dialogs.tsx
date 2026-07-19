import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { TOAST_DESCRIPTION_CLASS } from "./helpers";
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
            This permanently removes <span className="font-medium">{doc.title}</span> and all of its
            parsed chunks. The source file stays in R2 (v3 retention sweep will clean those up).
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
  const [mode, setMode] = useState<"full" | "chunksOnly" | "retryFailed">("full");
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
          {/* Option 1: Full re-run */}
          <label
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors",
              mode === "full" ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
            )}
          >
            <input
              type="radio"
              name="reprocess-mode"
              value="full"
              checked={mode === "full"}
              onChange={() => setMode("full")}
              className="mt-0.5 size-3.5 shrink-0 accent-foreground cursor-pointer"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium leading-tight">Full re-run</div>
              <div className="text-muted-foreground text-[11px] leading-snug mt-0.5">
                Re-render the PDF, re-run OCR, then re-chunk and re-embed. Uses OCR + embed API
                tokens.
              </div>
            </div>
          </label>

          {/* Option 2: Rebuild chunks from cache */}
          <label
            className={cn(
              "flex items-start gap-3 rounded-md border px-3 py-2.5 transition-colors",
              isChunksOnlyDisabled ? "opacity-50 cursor-not-allowed bg-muted/10" : "cursor-pointer",
              !isChunksOnlyDisabled && mode === "chunksOnly"
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/40",
            )}
          >
            <input
              type="radio"
              name="reprocess-mode"
              value="chunksOnly"
              checked={mode === "chunksOnly"}
              disabled={isChunksOnlyDisabled}
              onChange={() => setMode("chunksOnly")}
              className="mt-0.5 size-3.5 shrink-0 accent-foreground disabled:cursor-not-allowed"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium leading-tight flex items-center justify-between">
                <span>Rebuild chunks from pages</span>
                {isChunksOnlyDisabled && (
                  <span className="text-[9px] font-medium text-muted-foreground border px-1 rounded bg-muted/30">
                    No pages cache
                  </span>
                )}
              </div>
              <div className="text-muted-foreground text-[11px] leading-snug mt-0.5">
                Skip OCR — reuse the cached pages markdown to rebuild chunks + entities. Faster,
                fewer tokens.
              </div>
            </div>
          </label>

          {/* Option 3: Retry failed pages & rebuild */}
          <label
            className={cn(
              "flex items-start gap-3 rounded-md border px-3 py-2.5 transition-colors",
              isRetryFailedDisabled
                ? "opacity-50 cursor-not-allowed bg-muted/10"
                : "cursor-pointer",
              !isRetryFailedDisabled && mode === "retryFailed"
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/40",
            )}
          >
            <input
              type="radio"
              name="reprocess-mode"
              value="retryFailed"
              checked={mode === "retryFailed"}
              disabled={isRetryFailedDisabled}
              onChange={() => setMode("retryFailed")}
              className="mt-0.5 size-3.5 shrink-0 accent-foreground disabled:cursor-not-allowed"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium leading-tight flex items-center justify-between">
                <span>Retry failed pages & rebuild chunks</span>
                {isRetryFailedDisabled && (
                  <span className="text-[9px] font-medium text-muted-foreground border px-1 rounded bg-muted/30">
                    No failed pages
                  </span>
                )}
              </div>
              <div className="text-muted-foreground text-[11px] leading-snug mt-0.5">
                Only retry OCR for failed pages, keep successful pages, then rebuild chunks. Ideal
                for partial OCR errors.
              </div>
            </div>
          </label>
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

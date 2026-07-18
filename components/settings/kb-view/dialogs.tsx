import { useCallback, useEffect, useState } from "react";
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
  const [chunksOnly, setChunksOnly] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setChunksOnly(false);
      setError(null);
    }
  }, [open]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const qs = chunksOnly ? "?chunksOnly=true" : "";
      const res = await fetch(`/api/kb/documents/${doc.id}/reprocess${qs}`, { method: "POST" });
      if (res.status === 202) {
        toast.info(chunksOnly ? "Rechunks queued" : "Reprocess queued", {
          descriptionClassName: TOAST_DESCRIPTION_CLASS,
          description: chunksOnly
            ? `「${doc.title}」- skipping OCR, re-chunking from the existing pages. doc row stays Ready.`
            : `「${doc.title}」is re-running OCR + chunking. Old chunks were cleared.`,
        });
        onReprocessed();
        return;
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { code?: string; reason?: string };
        if (body.code === "NOT_READY") {
          setError(
            "Only rebuild chunks isn't available — pages haven't been extracted yet. Pick 'Full re-run' first.",
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
  }, [doc.id, doc.title, chunksOnly, onReprocessed]);

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
            re-running. Choose whether to re-run OCR or only rebuild chunks from the cached pages.
          </DialogDescription>
        </DialogHeader>

        <fieldset disabled={submitting} className="space-y-2" aria-label="Reprocess mode">
          <label
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors",
              !chunksOnly ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
            )}
          >
            <input
              type="radio"
              name="reprocess-mode"
              value="full"
              checked={!chunksOnly}
              onChange={() => setChunksOnly(false)}
              className="mt-0.5 size-3.5 shrink-0 accent-foreground"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium leading-tight">Full re-run</div>
              <div className="text-muted-foreground text-[11px] leading-snug mt-0.5">
                Re-render the PDF, re-run OCR, then re-chunk and re-embed. Uses OCR + embed API
                tokens.
              </div>
            </div>
          </label>
          <label
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors",
              chunksOnly ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
            )}
          >
            <input
              type="radio"
              name="reprocess-mode"
              value="chunksOnly"
              checked={chunksOnly}
              onChange={() => setChunksOnly(true)}
              className="mt-0.5 size-3.5 shrink-0 accent-foreground"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium leading-tight">Only rebuild chunks</div>
              <div className="text-muted-foreground text-[11px] leading-snug mt-0.5">
                Skip OCR — reuse the cached <code>pages[].markdown</code>. Only chunks + entities
                rebuild. Faster, fewer tokens. Doc row stays Ready the whole time.
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
            ) : chunksOnly ? (
              "Rebuild chunks"
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

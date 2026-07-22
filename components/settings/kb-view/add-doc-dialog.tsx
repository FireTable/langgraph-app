"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Link2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { buildAcceptAttribute, formatAcceptList } from "@/lib/kb/source-kind";
import { handleAddDoc, handleAddMultipleDocs, TOAST_DESCRIPTION_CLASS } from "./helpers";

// ponytail: single entry point for adding a doc — Upload File on top,
// From URL below. accept comes from window.__CONFIG__ so the
// composer + KB dialog stay in sync with the server-side allow list.

function readAllowedAccept(): string {
  if (typeof window === "undefined") return "application/pdf";
  const raw = window.__CONFIG__?.R2_ALLOWED_CONTENT_TYPES;
  if (!raw) return "application/pdf";
  return buildAcceptAttribute(raw);
}

function readSupportedLabels(): string[] {
  if (typeof window === "undefined") return [];
  const raw = window.__CONFIG__?.R2_ALLOWED_CONTENT_TYPES ?? "";
  return formatAcceptList(raw);
}

export function AddDocDialog({
  open,
  onOpenChange,
  folderId,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderId: string | null;
  onSuccess?: () => void | Promise<void>;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [url, setUrl] = useState("");
  const [fileSubmitting, setFileSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ completed: number; total: number } | null>(
    null,
  );
  const [urlSubmitting, setUrlSubmitting] = useState(false);
  const [accept] = useState(() => readAllowedAccept());
  const [supportedLabels] = useState(() => readSupportedLabels());

  // ponytail: gate Add URL on new URL() succeeding and yielding a real
  // http/https URL with a dotted host — i.e. something the server's
  // jina fetch can actually try to extract content from. new URL() is
  // the single source of truth: it rejects malformed input ("///", " ",
  // bare scheme) on its own, so the old host regex was redundant
  // belt-and-suspenders. Server-side validateIngestUrl is the real
  // security boundary (DNS + private-IP deny); this just stops the
  // button being clickable on garbage so the user gets feedback before
  // round-tripping to /api/kb/upload.
  //
  // Two guards on top of new URL():
  //   - dotted host: rejects `https:///path` (parsed as host="path") and
  //     `https://fire` (no TLD). Without this, new URL() accepts both
  //     and the button would falsely enable.
  //   - scheme-aware auto-prepend: only prepend `https://` when the
  //     input has NO scheme prefix. If user types `ftp://x.com`,
  //     blindly prepending yields `https://ftp://x.com`, which new
  //     URL() parses with host="x.com" — wrong protocol sneaks through.
  //     Detect any scheme (`scheme://`) and pass through unchanged; the
  //     protocol check then rejects non-http(s).
  const urlValid = useMemo(() => {
    const trimmed = url.trim();
    if (!trimmed) return false;
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
    try {
      const u = new URL(withScheme);
      return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".");
    } catch {
      return false;
    }
  }, [url]);

  const onPickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = "";
      if (files.length === 0 || !folderId) return;
      setFileSubmitting(true);
      setUploadProgress(null);
      try {
        // ponytail: only close the dialog when handleAddMultipleDocs actually
        // succeeded at least one file — on total failure it has already toasted
        // the error and the user needs to retry without losing context.
        const { successCount } = await handleAddMultipleDocs(
          files,
          folderId,
          () => onSuccess?.(),
          (completed, total) => setUploadProgress({ completed, total }),
        );
        if (successCount > 0) onOpenChange(false);
      } finally {
        setFileSubmitting(false);
        setUploadProgress(null);
      }
    },
    [folderId, onOpenChange, onSuccess],
  );

  const onAddUrl = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed || !folderId) return;
    setUrlSubmitting(true);
    try {
      const res = await fetch("/api/kb/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId, url: trimmed }),
      });
      if (res.ok && res.status === 200) {
        const body = (await res.json()) as { doc?: { title?: string }; deduped?: boolean };
        toast.info("Already in knowledge base", {
          descriptionClassName: TOAST_DESCRIPTION_CLASS,
          description: `「${body.doc?.title ?? trimmed}」was previously ingested — skipped duplicate.`,
        });
      } else if (res.status === 202) {
        const body = (await res.json()) as { doc?: { title?: string } };
        toast.success("URL queued", {
          descriptionClassName: TOAST_DESCRIPTION_CLASS,
          description: `「${body.doc?.title ?? trimmed}」is being ingested. Status will flip Pending → Parsing → Ready.`,
        });
      } else {
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        toast.error("Failed to add URL", {
          descriptionClassName: TOAST_DESCRIPTION_CLASS,
          description: body.code ?? `HTTP ${res.status}`,
        });
        return;
      }
      await onSuccess?.();
      onOpenChange(false);
      setUrl("");
    } catch (err) {
      console.error("Add URL failed", err);
      toast.error("Failed to add URL", {
        descriptionClassName: TOAST_DESCRIPTION_CLASS,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUrlSubmitting(false);
    }
  }, [folderId, onOpenChange, onSuccess, url]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to Knowledge Base</DialogTitle>
          <DialogDescription>
            Upload files or fetch a URL. All supported types are parsed automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-2">
            <Label htmlFor="kb-add-file">Upload Files</Label>
            <input
              id="kb-add-file"
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              accept={accept}
              onChange={onFileChange}
            />
            <Button
              type="button"
              variant={"outline"}
              disabled={fileSubmitting || !folderId}
              onClick={onPickFile}
              className="gap-2"
            >
              {fileSubmitting ? (
                <>
                  <Spinner />
                  {uploadProgress && uploadProgress.total > 1
                    ? `Uploading (${uploadProgress.completed}/${uploadProgress.total})…`
                    : "Uploading…"}
                </>
              ) : (
                <>
                  <Upload className="size-3.5" aria-hidden />
                  Choose file(s)
                </>
              )}
            </Button>
            {supportedLabels.length > 0 ? (
              <p className="text-[11px] text-muted-foreground/70">
                Supports File Extensions:{" "}
                {supportedLabels.map((item) => `.${item?.toLocaleLowerCase()}`).join(", ")}
              </p>
            ) : null}
          </section>

          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-muted-foreground text-xs">or</span>
            <Separator className="flex-1" />
          </div>

          <section className="flex flex-col gap-2">
            <Label htmlFor="kb-add-url">From URL</Label>
            <div className="flex gap-2">
              <Input
                id="kb-add-url"
                type="url"
                placeholder="https://example.com/article"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={urlSubmitting}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void onAddUrl();
                  }
                }}
              />
              <Button
                type="button"
                disabled={urlSubmitting || !urlValid || !folderId}
                onClick={() => void onAddUrl()}
                className="gap-2"
              >
                {urlSubmitting ? (
                  <>
                    <Spinner />
                    Parsing…
                  </>
                ) : (
                  <>
                    <Link2 className="size-3.5" aria-hidden />
                    Add URL
                  </>
                )}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              Page content is converted to markdown before chunking
            </p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

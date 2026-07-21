"use client";

import { useCallback, useMemo, useRef, useState } from "react";
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
import { handleAddDoc, TOAST_DESCRIPTION_CLASS } from "./helpers";

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
  const [urlSubmitting, setUrlSubmitting] = useState(false);
  const [accept] = useState(() => readAllowedAccept());
  const [supportedLabels] = useState(() => readSupportedLabels());

  // ponytail: gate the Add URL button on a parseable http(s) URL.
  // Client-side reachability probe (HEAD) is unreliable (CORS, server
  // support, opaque responses) — the server's /api/kb/upload gives a
  // proper error on bad URLs. We only verify format here, with two
  // guards: regex pre-check on the host (catches obvious garbage
  // like "///" or "   ") and new URL as the source of truth.
  //
  // `new URL`'s second arg acts as a base: typing `firetable.tech`
  // resolves to `https://firetable.tech/` without forcing the user
  // to type the scheme. Regex / new URL combo so a pasted URL with
  // scheme also still works.
  const urlValid = useMemo(() => {
    const trimmed = url.trim();
    if (!trimmed) return false;
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const hostMatch = withScheme.match(/^https?:\/\/([^/?#:]+)/i);
    if (!hostMatch) return false;
    // ponytail: reject obvious garbage like "fire" (no TLD), "..",
    // trailing dashes. Each label must start + end with [a-z0-9],
    // labels separated by dots, and the TLD must be ≥ 2 chars.
    const host = hostMatch[1].toLowerCase();
    if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(host)) {
      return false;
    }
    try {
      const u = new URL(withScheme);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, [url]);

  const onPickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !folderId) return;
      setFileSubmitting(true);
      try {
        await handleAddDoc(file, folderId, () => onSuccess?.());
        onOpenChange(false);
      } finally {
        setFileSubmitting(false);
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
            Upload a file or fetch a URL. All supported types are parsed automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-2">
            <Label htmlFor="kb-add-file">Upload File</Label>
            <input
              id="kb-add-file"
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept={accept}
              onChange={onFileChange}
            />
            <Button type="button" disabled={fileSubmitting || !folderId} onClick={onPickFile}>
              {fileSubmitting ? (
                <>
                  <Spinner />
                  Uploading…
                </>
              ) : (
                "Choose file"
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
              >
                {urlSubmitting ? (
                  <>
                    <Spinner />
                    Parsing…
                  </>
                ) : (
                  "Add URL"
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

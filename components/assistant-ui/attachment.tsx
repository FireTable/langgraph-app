"use client";

import { type PropsWithChildren, useEffect, useMemo, useState, type FC } from "react";
import { useRouter } from "next/navigation";
import { XIcon, PlusIcon, FileText, Loader2Icon } from "lucide-react";
import { AttachmentPrimitive, ComposerPrimitive, useAuiState, useAui } from "@assistant-ui/react";
import type { CompleteAttachment } from "@assistant-ui/react";
import { useShallow } from "zustand/shallow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogTitle, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { useUploadStore } from "@/lib/attachments/upload-store";

const KB_SETTINGS_PATH = "/settings/knowledge-base";

// ponytail: client-side object URL for a pending File. Drops on unmount.
const useFileSrc = (file: File | undefined) => {
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!file) {
      setSrc(undefined);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setSrc(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return src;
};

// ponytail: read src from SDK attachment state (composer path only).
// Falls back to a pending File's object URL; otherwise the committed
// image content part.
const useAttachmentSrc = () => {
  const { file, src } = useAuiState(
    useShallow((s): { file?: File; src?: string } => {
      if (s.attachment.type !== "image") return {};
      if (s.attachment.file) return { file: s.attachment.file };
      const src = s.attachment.content?.filter((c) => c.type === "image")[0]?.image;
      if (!src) return {};
      return { src };
    }),
  );

  return useFileSrc(file) ?? src;
};

type AttachmentPreviewProps = {
  src: string;
};

// ponytail: opacity-fade instead of `invisible` so the dialog's flex
// container doesn't collapse to 0 height while the image streams in.
// The `<img>` still occupies its natural box; onLoad crossfades to
// fully visible. Removing the `invisible` class on the loading state
// is what fixes the jank — display:none is what triggered the
// layout collapse.
const AttachmentPreview: FC<AttachmentPreviewProps & { onLoad?: () => void }> = ({
  src,
  onLoad,
}) => {
  const [isLoaded, setIsLoaded] = useState(false);
  return (
    <img
      src={src}
      alt="Attachment preview"
      // ponytail: h-full w-full + object-contain lets the <img> element
      // fill the parent's aspect-square box and the browser letterboxes the
      // actual image inside. The previous h-auto/max-h-[80vh]/max-w-full
      // mix let tall portraits compute a viewport-relative size larger than
      // the parent (80vh vs parent's 80dvh) and push past overflow-hidden.
      className={cn(
        "max-h-full rounded-lg object-contain transition-opacity duration-200",
        isLoaded
          ? "aui-attachment-preview-image-loaded opacity-100"
          : "aui-attachment-preview-image-loading opacity-0",
      )}
      onLoad={() => {
        setIsLoaded(true);
        onLoad?.();
      }}
    />
  );
};

// ponytail: pure preview dialog driven by a `src` prop. No SDK state
// access — safe to render anywhere (message path, server components,
// etc.). For the composer path we mount the SDK-state wrapper below,
// which reads `s.attachment` and forwards as src.
const AttachmentPreviewDialog: FC<PropsWithChildren<{ src?: string }>> = ({ children, src }) => {
  const [isLoaded, setIsLoaded] = useState(false);

  // ponytail: reset loaded state when src changes so opening a different
  // attachment after the first one finishes shows the skeleton again.
  useEffect(() => {
    setIsLoaded(false);
  }, [src]);

  if (!src) return <>{children}</>;

  return (
    <Dialog>
      <DialogTrigger
        className="aui-attachment-preview-trigger hover:bg-accent/50 cursor-pointer transition-colors"
        asChild
      >
        {children}
      </DialogTrigger>
      <DialogContent className="aui-attachment-preview-dialog-content [&>button]:bg-foreground/60 [&_svg]:text-background p-2 sm:max-w-3xl [&>button]:rounded-full [&>button]:p-1 [&>button]:opacity-70 [&>button]:hover:opacity-100 [&>button]:transition-opacity [&>button]:ring-0!">
        <DialogTitle className="aui-sr-only sr-only">Image Attachment Preview</DialogTitle>
        {/* ponytail: aspect-square caps both axes so the dialog doesn't
            grow with image dimensions — a tall portrait would otherwise
            push max-h-[80dvh] and force vertical scroll. aspect-square
            fixes both axes at 1:1, max-h-[80dvh] keeps the box in view,
            object-contain on the <img> below letterboxes non-square
            sources instead of cropping. */}
        <div className="aui-attachment-preview bg-background relative mx-auto flex aspect-square max-h-[80dvh] max-w-[80dvh] w-full items-center justify-center overflow-hidden">
          {/* ponytail: skeleton placeholder. absolute inset-0 covers the
              whole flex container; the <img> fades in over it via opacity
              transition. Removed once the image has decoded so it can't
              bleed through any transparent areas of the loaded image. */}
          {!isLoaded && (
            <div
              className="aui-attachment-skeleton absolute inset-0 bg-muted animate-pulse"
              aria-hidden
            />
          )}
          <AttachmentPreview src={src} onLoad={() => setIsLoaded(true)} />
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ponytail: SDK-state wrapper. Mounted only inside the SDK's attachment
// runtime scope (ComposerPrimitive / MessagePrimitive .Attachments) so
// `useAuiState(s => s.attachment)` is valid. Splits the hook call into
// a child so callers without that scope can use the prop-based dialog
// above without violating React hook rules.
const AttachmentPreviewDialogWithSdk: FC<PropsWithChildren> = ({ children }) => {
  const src = useAttachmentSrc();
  return <AttachmentPreviewDialog src={src}>{children}</AttachmentPreviewDialog>;
};

const AttachmentThumb: FC<{ src?: string }> = ({ src }) => {
  return (
    <Avatar className="aui-attachment-tile-avatar h-full w-full rounded-none">
      <AvatarImage
        src={src}
        alt="Attachment preview"
        className="aui-attachment-tile-image object-cover"
      />
      <AvatarFallback>
        <FileText className="aui-attachment-tile-fallback-icon text-muted-foreground size-8" />
      </AvatarFallback>
    </Avatar>
  );
};

const AttachmentThumbWithSdk: FC = () => {
  const src = useAttachmentSrc();
  return <AttachmentThumb src={src} />;
};

const AttachmentRemove: FC = () => {
  // ponytail: lock the X button while r2-adapter.send() is in flight.
  // SDK keeps the chip in `requires-action` until upload finishes; if
  // the user removes mid-flight the pending disappears from the
  // composer's attachments array but the network round-trip is still
  // pending, so the message lands without the file or with a phantom
  // chip. Easier to disable than to coordinate remove with the
  // adapter's finally block.
  //
  // ponytail: swap X for Loader2 while uploading — disabled-opacity-40
  // is invisible against the white chip background, so we use a spinner
  // (matching the Send button) to make the lock state self-evident.
  const isUploading = useUploadStore((s) => s.count > 0);
  return (
    <AttachmentPrimitive.Remove asChild>
      <TooltipIconButton
        tooltip={isUploading ? "Uploading…" : "Remove file"}
        className={cn(
          "aui-attachment-tile-remove text-muted-foreground absolute end-1.5 top-1.5 flex size-3.5 items-center justify-center rounded-full bg-white opacity-100 shadow-sm [&_svg]:text-black",
          isUploading
            ? "cursor-progress"
            : "hover:[&_svg]:text-destructive hover:bg-white! disabled:opacity-40 disabled:cursor-not-allowed",
        )}
        side="top"
        disabled={isUploading}
      >
        {isUploading ? (
          <Loader2Icon className="aui-attachment-remove-icon size-3 animate-spin" />
        ) : (
          <XIcon className="aui-attachment-remove-icon size-3 dark:stroke-[2.5px]" />
        )}
      </TooltipIconButton>
    </AttachmentPrimitive.Remove>
  );
};

// ponytail: composer-path card. Reads everything from the SDK's
// attachment runtime (AttachmentPrimitive / useAuiState) so the
// optimistic UI, status flips, and remove handler all stay in lockstep
// with the runtime. No props — there's only ever one attachment per slot.
const AttachmentUI: FC = () => {
  const aui = useAui();
  const isComposer = aui.attachment.source !== "message";
  const isImage = useAuiState((s) => s.attachment.type === "image");
  const typeLabel = useAuiState((s) => {
    const type = s.attachment.type;
    switch (type) {
      case "image":
        return "Image";
      case "document":
        return "Document";
      case "file":
        return "File";
      default:
        return type;
    }
  });

  // ponytail: dim the chip while r2-adapter.send() is in flight. This
  // runs alongside the X→Loader2 swap on AttachmentRemove — together
  // they signal "locked, uploading" without depending on SDK's
  // status="running" UI (which we can't reach from the deferred-upload
  // contract; see sdk-attachment-progress-add-only).
  const isUploading = useUploadStore((s) => s.count > 0);

  return (
    <Tooltip>
      <AttachmentPrimitive.Root
        className={cn(
          "aui-attachment-root relative",
          isImage && !isComposer && "aui-attachment-root-message only:*:first:size-24",
          isComposer && isUploading && "opacity-60",
        )}
      >
        <AttachmentPreviewDialogWithSdk>
          <TooltipTrigger asChild>
            <div
              className="aui-attachment-tile bg-muted size-14 cursor-pointer overflow-hidden rounded-[calc(var(--composer-radius)-var(--composer-padding))] border transition-opacity hover:opacity-75"
              role="button"
              tabIndex={0}
              aria-label={`${typeLabel} attachment`}
            >
              <AttachmentThumbWithSdk />
            </div>
          </TooltipTrigger>
        </AttachmentPreviewDialogWithSdk>
        {isComposer && <AttachmentRemove />}
      </AttachmentPrimitive.Root>
      <TooltipContent side="top">
        <AttachmentPrimitive.Name />
      </TooltipContent>
    </Tooltip>
  );
};

// ponytail: prop-based message-path card. Renders one attachment for
// the message-list. No SDK attachment runtime here — the attachment
// data is plain JS, sourced from message.content by the parent.
type MessageAttachmentCardProps = {
  attachment: CompleteAttachment;
};

const MessageAttachmentCard: FC<MessageAttachmentCardProps> = ({ attachment }) => {
  const router = useRouter();
  const src = useMemo(
    () => attachment.content?.find((c) => c.type === "image")?.image,
    [attachment],
  );
  const isImage = attachment.type === "image";
  // ponytail: kbAgent stamps a `kb_ref` content part onto a file tile
  // when the file got ingested into KB. We read it once and use it to
  // (a) override the click target (deep-link into /settings/... rather
  // than open the file preview dialog) and (b) rename the tile label
  // from "File" to "KB document". No custom aUI tile type — the
  // CompleteAttachment is still `type: "file"`, the marker just rides
  // in content.
  const kbRefDocId = useMemo(() => {
    const part = attachment.content?.find(
      (c) => (c as unknown as { type?: string }).type === "kb_ref",
    ) as { docId?: string } | undefined;
    return part?.docId ?? null;
  }, [attachment]);
  const isKbDoc = kbRefDocId !== null;
  const typeLabel = useMemo(() => {
    if (isKbDoc) return "KB document";
    switch (attachment.type) {
      case "image":
        return "Image";
      case "document":
        return "Document";
      case "file":
        return "File";
      default:
        return attachment.type;
    }
  }, [attachment.type, isKbDoc]);

  const activate = () => {
    if (kbRefDocId) router.push(`${KB_SETTINGS_PATH}?doc=${encodeURIComponent(kbRefDocId)}`);
  };

  return (
    <Tooltip>
      <div
        data-slot="aui-attachment-root"
        className={cn(
          "aui-attachment-root relative",
          isImage && "aui-attachment-root-message only:*:first:size-24",
        )}
      >
        {isKbDoc ? (
          <TooltipTrigger asChild>
            <div
              className="aui-attachment-tile bg-muted size-14 cursor-pointer overflow-hidden rounded-[calc(var(--composer-radius)-var(--composer-padding))] border transition-opacity hover:opacity-75"
              role="button"
              tabIndex={0}
              aria-label={`${typeLabel} attachment`}
              onClick={activate}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activate();
                }
              }}
            >
              <AttachmentThumb src={undefined} />
            </div>
          </TooltipTrigger>
        ) : (
          <AttachmentPreviewDialog src={src}>
            <TooltipTrigger asChild>
              <div
                className="aui-attachment-tile bg-muted size-14 cursor-pointer overflow-hidden rounded-[calc(var(--composer-radius)-var(--composer-padding))] border transition-opacity hover:opacity-75"
                role="button"
                tabIndex={0}
                aria-label={`${typeLabel} attachment`}
              >
                <AttachmentThumb src={src} />
              </div>
            </TooltipTrigger>
          </AttachmentPreviewDialog>
        )}
      </div>
      <TooltipContent side="top">{attachment.name}</TooltipContent>
    </Tooltip>
  );
};

// ponytail: this component used to wrap `<MessagePrimitive.Attachments>`
// directly and read `s.message.attachments` — the assistant-ui standard
// way to render a per-message attachment row. That broke once we moved
// to `useLangGraphRuntime`: the SDK's `toLangGraphUserMessage` flattens
// attachments into `content` and discards the field, so the runtime
// state has no `attachments` and `<MessagePrimitive.Attachments>` renders
// nothing (see assistant-ui/assistant-ui#4790). Rebuilding the list from
// `message.content` works around it — image parts carry the URL, file
// parts carry filename + mimeType.
//
// Migration plan: when assistant-ui#4790 ships a fix (or we ship a
// patched SDK locally), restore the original implementation:
//   return (
//     <div className="...">
//       <MessagePrimitive.Attachments>{() => <MessageAttachmentCardFromSdk />}</MessagePrimitive.Attachments>
//     </div>
//   );
// and delete the message.content parser below. The visual is identical
// (same `MessageAttachmentCard` shape), so no UX change is needed at
// switchover.
// ponytail: image parts in message.content carry only the URL — the
// SDK's `contentToParts` drops `filename` on the round trip through
// `image_url`. R2 keys look like `u/<userId>/<uuid>-<filename>`, so
// the last URL segment is the original filename with the uuid prefix
// stripped.
function filenameFromImageUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    const decoded = decodeURIComponent(last);
    const stripped = decoded.replace(/^[0-9a-f-]{36}-/, "");
    return stripped || "image";
  } catch {
    return "image";
  }
}

function asRecord(part: unknown): Record<string, unknown> {
  return part as Record<string, unknown>;
}

// ponytail: read a `kb_ref` sibling off a content part's raw record.
// The sibling may not have survived the SDK's `contentToParts` switch
// (it rebuilds the object from scratch with a fixed shape per type) —
// if it didn't, the runtime delivers the part without the sibling and
// we fall through to the plain image / file branch. Shape matches
// lib/kb/extract.ts:KbRefMarker, narrowed inline so this file stays
// free of @/lib/* imports.
function readKbRefSibling(
  r: Record<string, unknown>,
): { docId: string; attachmentId?: string } | null {
  const raw = r.kb_ref;
  if (typeof raw !== "object" || raw === null) return null;
  const docId = (raw as { docId?: unknown }).docId;
  if (typeof docId !== "string") return null;
  return raw as { docId: string; attachmentId?: string };
}

// ponytail: pure projection of message.content → CompleteAttachment[].
// File tiles always come out as `type: "file"`; if the source part
// carries a `kb_ref` sibling, the same tile gets a marker content
// part `{ type: "kb_ref", docId }` appended. MessageAttachmentCard
// reads the marker to decide whether to deep-link into /settings/
// knowledge-base or open the file preview. Image parts don't carry
// the sibling (SDK's image case drops unknown fields), so they
// always render plain.
function buildUserMessageAttachments(parts: readonly unknown[]): CompleteAttachment[] {
  const seen = new Set<string>();
  const out: CompleteAttachment[] = [];
  for (const part of parts) {
    const r = asRecord(part);
    const type = r.type;

    if (type === "image" && typeof r.image === "string") {
      const url = r.image;
      const name = filenameFromImageUrl(url);
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        id: url,
        type: "image",
        name,
        contentType: "image",
        status: { type: "complete" },
        content: [{ type: "image", image: url, filename: name }],
      });
    } else if (type === "file" && typeof r.data === "string") {
      // ponytail: SDK's contentToParts defaults filename to "file"
      // when the source part lacks `metadata.filename`, but the type
      // still allows undefined. Fall back to "file" so we always
      // have a non-empty id / name.
      const fileName = (typeof r.filename === "string" && r.filename) || "file";
      const mimeType = typeof r.mimeType === "string" ? r.mimeType : "";
      const kbRef = readKbRefSibling(r);
      // ponytail: dedupe on docId when the file is KB-tagged, otherwise
      // on filename. A retried / duplicate upload with the same name
      // but a different docId would otherwise show two tiles; the same
      // file uploaded twice with no docId change stays as one tile.
      const key = kbRef ? `kb_ref:${kbRef.docId}` : fileName;
      if (seen.has(key)) continue;
      seen.add(key);
      const fileContent = {
        type: "file" as const,
        data: r.data,
        mimeType,
        filename: fileName,
      };
      out.push({
        id: key,
        type: "file",
        name: fileName,
        contentType: mimeType,
        status: { type: "complete" },
        content: kbRef
          ? [
              fileContent,
              {
                type: "kb_ref",
                docId: kbRef.docId,
              } as unknown as CompleteAttachment["content"][number],
            ]
          : [fileContent],
      });
    }
    // legacy standalone `{ type: "kb_ref", docId }` parts (older
    // threads) are dropped here — the parent message still has the
    // file part that produced the original upload, and that file
    // part will carry a kb_ref sibling on any subsequent re-ingest.
  }
  return out;
}

export const UserMessageAttachments: FC = () => {
  const content = useAuiState((s) => s.message.content);

  const attachments = useMemo<CompleteAttachment[]>(
    () => buildUserMessageAttachments(content),
    [content],
  );

  if (attachments.length === 0) return null;

  return (
    <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row justify-end gap-2">
      {attachments.map((a) => (
        <MessageAttachmentCard key={a.id} attachment={a} />
      ))}
    </div>
  );
};

export const ComposerAttachments: FC = () => {
  return (
    <div className="aui-composer-attachments flex w-full flex-row items-center gap-2 overflow-x-auto empty:hidden">
      <ComposerPrimitive.Attachments>{() => <AttachmentUI />}</ComposerPrimitive.Attachments>
    </div>
  );
};

export const ComposerAddAttachment: FC = () => {
  // ponytail: lock the Plus while a previous attachment is uploading
  // so the composer doesn't accumulate overlapping uploads. SDK calls
  // adapter.send on each pending attachment in Promise.all, so two
  // would actually run — but for the user the experience is jarring
  // (two spinner windows instead of one). Disable until count===0.
  const isUploading = useUploadStore((s) => s.count > 0);
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <TooltipIconButton
        tooltip={isUploading ? "Uploading…" : "Add Attachment"}
        side="bottom"
        variant="ghost"
        size="icon"
        className="aui-composer-add-attachment hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full p-1 text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
        aria-label="Add Attachment"
        disabled={isUploading}
      >
        <PlusIcon className="aui-attachment-add-icon size-4.5 stroke-[1.5px]" />
      </TooltipIconButton>
    </ComposerPrimitive.AddAttachment>
  );
};

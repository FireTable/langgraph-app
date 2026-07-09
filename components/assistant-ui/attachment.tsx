"use client";

import { type PropsWithChildren, useEffect, useMemo, useState, type FC } from "react";
import { XIcon, PlusIcon, FileText } from "lucide-react";
import { AttachmentPrimitive, ComposerPrimitive, useAuiState, useAui } from "@assistant-ui/react";
import type { CompleteAttachment, ThreadUserMessagePart } from "@assistant-ui/react";
import { useShallow } from "zustand/shallow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogTitle, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

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
      className={cn(
        "block h-auto max-h-[80vh] w-auto max-w-full object-contain transition-opacity duration-200",
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
      <DialogContent className="aui-attachment-preview-dialog-content [&>button]:bg-foreground/60 [&_svg]:text-background [&>button]:hover:[&_svg]:text-destructive p-2 sm:max-w-3xl [&>button]:rounded-full [&>button]:p-1 [&>button]:opacity-100 [&>button]:ring-0!">
        <DialogTitle className="aui-sr-only sr-only">Image Attachment Preview</DialogTitle>
        {/* ponytail: min-h keeps the DialogContent from collapsing to 0
            while the <img> is still streaming — pre-decode <img> reports
            0×0, which would otherwise shrink the flex container and the
            surrounding dialog. min-h-[60vh] gives a stable box; the
            image's own max-h-[80vh]+object-contain still does the final
            sizing once it's loaded. */}
        <div className="aui-attachment-preview bg-background relative mx-auto flex min-h-[60vh] max-h-[80dvh] w-full items-center justify-center overflow-hidden">
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
  return (
    <AttachmentPrimitive.Remove asChild>
      <TooltipIconButton
        tooltip="Remove file"
        className="aui-attachment-tile-remove text-muted-foreground hover:[&_svg]:text-destructive absolute end-1.5 top-1.5 size-3.5 rounded-full bg-white opacity-100 shadow-sm hover:bg-white! [&_svg]:text-black"
        side="top"
      >
        <XIcon className="aui-attachment-remove-icon size-3 dark:stroke-[2.5px]" />
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

  return (
    <Tooltip>
      <AttachmentPrimitive.Root
        className={cn(
          "aui-attachment-root relative",
          isImage && !isComposer && "aui-attachment-root-message only:*:first:size-24",
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

// ponytail: prop-based message-path card. Renders one attachment for
// the message-list. No SDK attachment runtime here — the attachment
// data is plain JS, sourced from message.content by the parent.
type MessageAttachmentCardProps = {
  attachment: CompleteAttachment;
};

const MessageAttachmentCard: FC<MessageAttachmentCardProps> = ({ attachment }) => {
  const src = useMemo(
    () => attachment.content?.find((c) => c.type === "image")?.image,
    [attachment],
  );
  const isImage = attachment.type === "image";
  const typeLabel = useMemo(() => {
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
  }, [attachment.type]);

  return (
    <Tooltip>
      <div
        data-slot="aui-attachment-root"
        className={cn(
          "aui-attachment-root relative",
          isImage && "aui-attachment-root-message only:*:first:size-24",
        )}
      >
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
export const UserMessageAttachments: FC = () => {
  const content = useAuiState((s) => s.message.content);

  const attachments = useMemo<CompleteAttachment[]>(() => {
    const seen = new Set<string>();
    const result: CompleteAttachment[] = [];
    for (const part of content) {
      let key: string | undefined;
      let complete: CompleteAttachment | undefined;
      if (part.type === "image") {
        const imagePart = part;
        const name = filenameFromImageUrl(imagePart.image);
        key = imagePart.image;
        complete = {
          id: imagePart.image,
          type: "image",
          name,
          contentType: "image",
          status: { type: "complete" },
          content: [
            {
              type: "image",
              image: imagePart.image,
              filename: name,
            },
          ],
        };
      } else if (part.type === "file") {
        const filePart = part as Extract<ThreadUserMessagePart, { type: "file" }>;
        // ponytail: SDK's contentToParts defaults filename to "file"
        // when the source part lacks `metadata.filename`, but the type
        // still allows undefined. Fall back to "file" so we always
        // have a non-empty id / name.
        const fileName = filePart.filename || "file";
        key = fileName;
        complete = {
          id: fileName,
          type: "file",
          name: fileName,
          contentType: filePart.mimeType,
          status: { type: "complete" },
          content: [
            {
              type: "file",
              data: filePart.data,
              mimeType: filePart.mimeType,
              filename: fileName,
            },
          ],
        };
      }
      if (complete && key && !seen.has(key)) {
        seen.add(key);
        result.push(complete);
      }
    }
    return result;
  }, [content]);

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
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <TooltipIconButton
        tooltip="Add Attachment"
        side="bottom"
        variant="ghost"
        size="icon"
        className="aui-composer-add-attachment hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full p-1 text-xs font-semibold"
        aria-label="Add Attachment"
      >
        <PlusIcon className="aui-attachment-add-icon size-4.5 stroke-[1.5px]" />
      </TooltipIconButton>
    </ComposerPrimitive.AddAttachment>
  );
};

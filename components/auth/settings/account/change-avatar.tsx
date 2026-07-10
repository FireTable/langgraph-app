"use client";

import { useAuth, useSession, useUpdateUser } from "@better-auth-ui/react";
import { Trash2, Upload } from "lucide-react";
import { type ChangeEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { UserAvatar } from "@/components/auth/user/user-avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export type ChangeAvatarProps = {
  className?: string;
};

// ponytail: avatars upload to R2 and we store ONLY the public URL. The
// old base64 fallback wrote a data URL into user.image, which the memory
// auth-overlay injected into every <memory> system block uncapped —
// issue #28's 372K-token blow-up. Gated on ATTACHMENTS_ENABLED (same R2
// backing as chat attachments — no separate flag). Off → uploads disabled.
// Read at render (matches app/assistant.tsx) — window.__CONFIG__ is
// injected beforeInteractive.
function avatarUploadsEnabled(): boolean {
  return typeof window !== "undefined" && window.__CONFIG__?.ATTACHMENTS_ENABLED === "true";
}

// ponytail: presign → PUT → return the public URL. Errors bubble to the
// caller's try/catch, which toasts them.
async function uploadAvatarToR2(file: File): Promise<string> {
  const presignRes = await fetch("/api/avatar/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, contentType: file.type, sizeBytes: file.size }),
  });
  if (!presignRes.ok) {
    throw new Error("Avatar upload is not available right now.");
  }
  const { uploadUrl, publicUrl, uploadHeaders } = await presignRes.json();
  const putRes = await fetch(uploadUrl, { method: "PUT", headers: uploadHeaders, body: file });
  if (!putRes.ok) {
    throw new Error("Failed to upload avatar.");
  }
  return publicUrl;
}

// ponytail: delete the R2 object behind a previous avatar URL. Owner-scoped
// + idempotent server-side; external (OAuth-hosted) URLs are a no-op there.
// Best-effort — a failed cleanup shouldn't block the user's action.
async function deleteAvatarFromR2(url: string | null | undefined): Promise<void> {
  if (!url) return;
  await fetch("/api/avatar", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  }).catch(() => undefined);
}

export function ChangeAvatar({ className }: ChangeAvatarProps) {
  const { authClient, localization, avatar } = useAuth();
  const { data: session } = useSession(authClient);

  const { mutate: updateUser, isPending: updatePending } = useUpdateUser(authClient);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const isPending = updatePending || isUploading || isDeleting;
  const canUpload = avatarUploadsEnabled();

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    e.target.value = "";

    if (!canUpload) {
      toast.error(
        "Avatar uploads are disabled — set the R2_* env vars and ATTACHMENTS_ENABLED=true.",
      );
      return;
    }

    const previousImage = session?.user.image;
    setIsUploading(true);

    try {
      const resized = (await avatar.resize?.(file, avatar.size, avatar.extension)) || file;

      const image = await uploadAvatarToR2(resized);

      updateUser(
        { image },
        {
          onSuccess: () => {
            void deleteAvatarFromR2(previousImage);
            toast.success(localization.settings.avatarChangedSuccess);
          },
        },
      );
    } catch (error) {
      if (error instanceof Error) {
        toast.error(error.message);
      }
    }

    setIsUploading(false);
  }

  async function handleDelete() {
    const currentImage = session?.user.image;

    updateUser(
      { image: null },
      {
        onSuccess: async () => {
          if (currentImage) {
            setIsDeleting(true);
            try {
              await deleteAvatarFromR2(currentImage);
            } finally {
              setIsDeleting(false);
            }
          }

          toast.success(localization.settings.avatarDeletedSuccess);
        },
      },
    );
  }

  return (
    <Field className={className}>
      <Label>{localization.settings.avatar}</Label>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      <div className="flex items-center gap-4">
        <Button
          type="button"
          variant="ghost"
          className="p-0 h-auto w-auto rounded-full"
          disabled={isPending || !canUpload}
          onClick={() => fileInputRef.current?.click()}
        >
          <UserAvatar className="size-12" isPending={isPending} />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
            disabled={!session || isPending}
          >
            {isPending && <Spinner />}

            {localization.settings.changeAvatar}
          </DropdownMenuTrigger>

          <DropdownMenuContent className="min-w-fit">
            <DropdownMenuItem disabled={!canUpload} onClick={() => fileInputRef.current?.click()}>
              <Upload className="text-muted-foreground" />

              {localization.settings.uploadAvatar}
            </DropdownMenuItem>

            <DropdownMenuItem
              variant="destructive"
              disabled={!session?.user.image}
              onClick={handleDelete}
            >
              <Trash2 />

              {localization.settings.deleteAvatar}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Field>
  );
}

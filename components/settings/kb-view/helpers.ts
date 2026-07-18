import { toast } from "sonner";

export const TOAST_DESCRIPTION_CLASS = "!text-foreground";

export async function sha256Hex(file: File): Promise<string | undefined> {
  try {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return undefined;
  }
}

export async function handleAddDoc(
  file: File,
  folderId: string,
  onRefresh: () => Promise<void> | void,
) {
  try {
    const sha = await sha256Hex(file);
    const presignRes = await fetch("/api/attachments/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        ...(sha ? { sha256: sha } : {}),
      }),
    });
    if (!presignRes.ok) throw new Error(`presign failed: ${presignRes.status}`);
    const presign = (await presignRes.json()) as {
      id: string;
      uploadUrl: string;
      uploadHeaders: Record<string, string>;
      publicUrl: string;
      skipUpload?: boolean;
    };

    if (!presign.skipUpload) {
      const putRes = await fetch(presign.uploadUrl, {
        method: "PUT",
        headers: presign.uploadHeaders,
        body: file,
      });
      if (!putRes.ok) throw new Error(`upload failed: ${putRes.status}`);

      const confirmRes = await fetch(`/api/attachments/${presign.id}/confirm`, { method: "POST" });
      if (!confirmRes.ok) throw new Error(`confirm failed: ${confirmRes.status}`);
    }

    const uploadRes = await fetch("/api/kb/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId, attachmentId: presign.id, title: file.name }),
    });
    if (!uploadRes.ok && uploadRes.status !== 202) {
      throw new Error(`kb upload failed: ${uploadRes.status}`);
    }
    if (uploadRes.status === 200) {
      const body = (await uploadRes.json()) as { deduped?: boolean; doc?: { title?: string } };
      if (body.deduped) {
        toast.info("Already in knowledge base", {
          descriptionClassName: TOAST_DESCRIPTION_CLASS,
          description: `「${body.doc?.title ?? file.name}」was previously uploaded — skipped duplicate.`,
        });
      }
    } else if (uploadRes.status === 202) {
      const body = (await uploadRes.json()) as { doc?: { title?: string } };
      toast.success("Upload queued", {
        descriptionClassName: TOAST_DESCRIPTION_CLASS,
        description: `「${body.doc?.title ?? file.name}」is being ingested. Status will flip Pending → Parsing → Ready.`,
      });
    }
    void onRefresh();
  } catch (err) {
    console.error("Add Doc failed", err);
  }
}

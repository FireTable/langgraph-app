"use client";

import { FileTextIcon, LoaderIcon } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { CardShell, CardHeader } from "@/components/tool-ui/primitives/card";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";

import type { ListDocResult } from "./types";

type ListArgs = {
  folderId?: string;
  status?: string;
  titleQuery?: string;
  page?: number;
  pageSize?: number;
};

export const KbListDocumentsToolUI: ToolCallMessagePartComponent<ListArgs> = ({ result }) => {
  const obj = unwrapToolResult<ListDocResult>(result);
  if (!obj) {
    return (
      <CardShell data-slot="kb-list-card" maxWidthClass="max-w-2xl">
        <CardHeader
          icon={<LoaderIcon className="size-4 animate-spin" />}
          title="Listing KB documents"
        />
      </CardShell>
    );
  }
  if (obj.empty || !obj.documents?.length) {
    return (
      <CardShell data-slot="kb-list-card" maxWidthClass="max-w-2xl">
        <CardHeader
          icon={<FileTextIcon className="size-4" />}
          title="KB is empty"
          subtitle="No documents matched the filter."
        />
      </CardShell>
    );
  }
  return (
    <CardShell data-slot="kb-list-card" maxWidthClass="max-w-2xl">
      <CardHeader
        icon={<FileTextIcon className="size-4" />}
        title={`KB documents · ${obj.documents.length}${obj.total != null ? ` of ${obj.total}` : ""}`}
      />
      <ul className="flex flex-col gap-1.5">
        {obj.documents.map((d) => (
          <li
            key={d.id}
            className="border-border/60 bg-muted/30 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
          >
            <FileTextIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate">{d.title}</span>
            <span className="text-muted-foreground ms-auto text-xs uppercase tracking-wide">
              {d.status}
            </span>
          </li>
        ))}
      </ul>
    </CardShell>
  );
};

"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { type RoleRow, jsonFetch, errMsg } from "@/app/admin/types";

export function RolesPanel({ initial }: { initial: RoleRow[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="mt-2">
          <h2 className="font-semibold">Roles</h2>
          <p className="text-muted-foreground text-xs mt-1">
            Roles set the per-window credit cap for users. A blank credit limit means unlimited.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
          Add role
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-xs">
            <tr>
              <th className="px-3 py-2 text-left font-medium">ID</th>
              <th className="px-3 py-2 text-left font-medium">Name</th>
              <th className="px-3 py-2 text-right font-medium">Credit limit</th>
              <th className="px-3 py-2 text-right font-medium">Window (h)</th>
              <th className="px-3 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {initial.map((r) => (
              <RoleRowView key={r.id} role={r} />
            ))}
          </tbody>
        </table>
      </div>

      <RoleDialog
        mode="add"
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          router.refresh();
        }}
      />
    </div>
  );
}

function RoleRowView({ role }: { role: RoleRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const remove = () => {
    start(async () => {
      const r = await jsonFetch(`/api/admin/roles/${encodeURIComponent(role.id)}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        toast.error(errMsg(r.body));
        return;
      }
      setConfirmingDelete(false);
      toast.success("role deleted");
      router.refresh();
    });
  };

  return (
    <tr className="border-t">
      <td className="px-3 py-2 font-mono text-xs">{role.id}</td>
      <td className="px-3 py-2">{role.name}</td>
      <td className="px-3 py-2 text-right font-mono text-xs">
        {role.creditLimit === null ? "unlimited" : role.creditLimit}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs">{role.windowHours}</td>
      <td className="px-3 py-2 text-right">
        <div className="flex justify-end gap-1">
          <Button variant="outline" size="xs" onClick={() => setEditing(true)} disabled={pending}>
            Edit
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => setConfirmingDelete(true)}
            disabled={pending}
            aria-label={`Delete ${role.id}`}
          >
            Delete
          </Button>
        </div>

        <Dialog
          open={confirmingDelete}
          onOpenChange={(open) => !open && setConfirmingDelete(false)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete this role?</DialogTitle>
              <DialogDescription>
                “{role.name}” will be removed. Users on this role fall back to the default. This
                cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                className="w-full md:w-auto"
                onClick={() => setConfirmingDelete(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                className="w-full md:w-auto"
                onClick={remove}
                disabled={pending}
                aria-busy={pending}
              >
                {pending ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden />
                    Deleting…
                  </>
                ) : (
                  "Delete"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </td>
      <RoleDialog
        mode="edit"
        open={editing}
        role={role}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          router.refresh();
        }}
      />
    </tr>
  );
}

function RoleDialog(
  props:
    | {
        mode: "add";
        open: boolean;
        onClose: () => void;
        onSaved: () => void;
      }
    | {
        mode: "edit";
        open?: boolean;
        role: RoleRow;
        onClose: () => void;
        onSaved: () => void;
      },
) {
  const isEdit = props.mode === "edit";
  const initialName = isEdit ? props.role.name : "";
  const initialLimit = isEdit
    ? props.role.creditLimit === null
      ? ""
      : String(props.role.creditLimit)
    : "";
  const initialHours = isEdit ? String(props.role.windowHours) : "24";

  const [id, setId] = useState(isEdit ? props.role.id : "");
  const [name, setName] = useState(initialName);
  const [limit, setLimit] = useState(initialLimit);
  const [hours, setHours] = useState(initialHours);
  const [saving, start] = useTransition();

  useEffect(() => {
    setName(initialName);
    setLimit(initialLimit);
    setHours(initialHours);
  }, [initialName, initialLimit, initialHours]);

  const save = () => {
    if (!name.trim()) {
      toast.error("name required");
      return;
    }
    if (!isEdit && !id.trim()) {
      toast.error("id required");
      return;
    }
    if (!isEdit && !/^[a-z][a-z0-9_-]*$/.test(id.trim())) {
      toast.error("id must be lowercase alphanumeric / dash / underscore");
      return;
    }
    const h = Number(hours);
    if (!Number.isInteger(h) || h < 1) {
      toast.error("windowHours must be a positive integer");
      return;
    }
    const limitNum = limit.trim() === "" ? null : Number(limit);
    if (limitNum !== null && (!Number.isFinite(limitNum) || limitNum < 0)) {
      toast.error("creditLimit must be a non-negative number or blank for unlimited");
      return;
    }
    start(async () => {
      let r;
      if (isEdit) {
        r = await jsonFetch(`/api/admin/roles/${encodeURIComponent(props.role.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ name: name.trim(), creditLimit: limitNum, windowHours: h }),
        });
      } else {
        r = await jsonFetch("/api/admin/roles", {
          method: "POST",
          body: JSON.stringify({
            id: id.trim(),
            name: name.trim(),
            creditLimit: limitNum,
            windowHours: h,
          }),
        });
      }
      if (!r.ok) {
        toast.error(errMsg(r.body));
        return;
      }
      toast.success(isEdit ? "role updated" : "role created");
      props.onSaved();
    });
  };

  return (
    <FormDialog
      open={isEdit ? (props.open ?? false) : props.open}
      onOpenChange={(o: boolean) => !o && props.onClose()}
      title={isEdit ? `Edit role: ${props.role.id}` : "Add role"}
      description={
        isEdit
          ? "ID is the FK identifier and can’t be changed here. Delete + recreate to rename."
          : "Roles set the per-window credit cap for users. A blank credit limit means unlimited."
      }
      submitLabel={isEdit ? "Save" : "Add"}
      pending={saving}
      onSubmit={save}
      onCancel={props.onClose}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">ID</span>
          <Input
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={isEdit || saving}
            placeholder="editor"
            className="font-mono"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={saving}
            placeholder="Editor"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Credit limit</span>
          <Input
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            disabled={saving}
            placeholder="blank = unlimited"
            type="number"
            step="1"
            min={0}
            className="font-mono"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Window (hours)</span>
          <Input
            type="number"
            min={1}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            disabled={saving}
            className="font-mono"
          />
        </label>
      </div>
    </FormDialog>
  );
}

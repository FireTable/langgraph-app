"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { type UserRow, type RoleRow, jsonFetch, errMsg } from "@/app/admin/types";

export function UsersPanel({ initial, roles }: { initial: UserRow[]; roles: RoleRow[] }) {
  const total = initial.length;
  const admins = initial.filter((u) => u.roleId === "admin").length;
  const banned = initial.filter((u) => u.banned).length;

  const todayCredits = initial.reduce((sum, u) => sum + (u.todayCredits ?? 0), 0);
  const todayInputTokens = initial.reduce((sum, u) => sum + (u.todayInputTokens ?? 0), 0);
  const todayOutputTokens = initial.reduce((sum, u) => sum + (u.todayOutputTokens ?? 0), 0);

  const totalCredits = initial.reduce((sum, u) => sum + (u.totalCredits ?? 0), 0);
  const totalInputTokens = initial.reduce((sum, u) => sum + (u.totalInputTokens ?? 0), 0);
  const totalOutputTokens = initial.reduce((sum, u) => sum + (u.totalOutputTokens ?? 0), 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="mt-2">
        <h2 className="font-semibold">Users</h2>
        <p className="text-muted-foreground text-xs mt-1">
          Registered accounts, their role, and ban status. Banning immediately revokes every active
          session for that user — they’re signed out on the next request.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <UserBreakdownCard total={total} admins={admins} banned={banned} />
        <UsageStatCard
          title="Today's Usage"
          credits={todayCredits}
          inputTokens={todayInputTokens}
          outputTokens={todayOutputTokens}
        />
        <UsageStatCard
          title="Total Usage"
          credits={totalCredits}
          inputTokens={totalInputTokens}
          outputTokens={totalOutputTokens}
        />
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-xs">
            <tr>
              <th className="px-3 py-2 text-left font-medium">User</th>
              <th className="px-3 py-2 text-left font-medium">Role</th>
              <th className="px-3 py-2 text-center font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Today's Usage</th>
              <th className="px-3 py-2 text-right font-medium">Total Usage</th>
              <th className="px-3 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {initial.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-muted-foreground px-3 py-3 text-center text-xs">
                  No users yet.
                </td>
              </tr>
            ) : (
              initial.map((u) => <UserRowView key={u.id} user={u} roles={roles} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UserBreakdownCard({
  total,
  admins,
  banned,
}: {
  total: number;
  admins: number;
  banned: number;
}) {
  const regular = Math.max(0, total - admins - banned);
  const adminPct = total > 0 ? (admins / total) * 100 : 0;
  const regularPct = total > 0 ? (regular / total) * 100 : 0;
  const bannedPct = total > 0 ? (banned / total) * 100 : 0;

  return (
    <Card className="bg-transparent py-3 flex flex-col justify-between">
      <CardContent className="flex flex-col gap-1.5 px-3">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
            Users
          </div>
          <span className="text-muted-foreground/70 font-mono text-[10px]">{total} registered</span>
        </div>

        <div className="flex items-baseline gap-1.5">
          <span className="text-foreground text-lg font-semibold tabular-nums">{total}</span>
          <span className="text-muted-foreground text-[11px]">users</span>
        </div>

        <div className="mt-1 flex flex-col gap-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted flex cursor-pointer">
                  {total > 0 ? (
                    <>
                      <div
                        style={{ width: `${adminPct}%` }}
                        className="bg-primary h-full transition-all duration-300"
                      />
                      <div
                        style={{ width: `${regularPct}%` }}
                        className="bg-sky-500/80 h-full transition-all duration-300"
                      />
                      <div
                        style={{ width: `${bannedPct}%` }}
                        className="bg-rose-500/80 h-full transition-all duration-300"
                      />
                    </>
                  ) : (
                    <div className="w-full bg-muted-foreground/15 h-full" />
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs font-mono flex flex-col gap-0.5">
                <div>
                  admins: {admins} ({adminPct.toFixed(1)}%)
                </div>
                <div>
                  active: {regular} ({regularPct.toFixed(1)}%)
                </div>
                <div>
                  banned: {banned} ({bannedPct.toFixed(1)}%)
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
            <div className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-primary inline-block shrink-0" />
              <span>Admin: {admins}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-sky-500/80 inline-block shrink-0" />
              <span>Active: {regular}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-rose-500/80 inline-block shrink-0" />
              <span>Banned: {banned}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function UsageStatCard({
  title,
  credits,
  inputTokens,
  outputTokens,
}: {
  title: string;
  credits: number;
  inputTokens: number;
  outputTokens: number;
}) {
  const totalTokens = inputTokens + outputTokens;
  const inputPct = totalTokens > 0 ? (inputTokens / totalTokens) * 100 : 0;
  const outputPct = totalTokens > 0 ? 100 - inputPct : 0;

  return (
    <Card className="bg-transparent py-3 flex flex-col justify-between">
      <CardContent className="flex flex-col gap-1.5 px-3">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
            {title}
          </div>
          <span className="text-muted-foreground/70 font-mono text-[10px]">
            {totalTokens.toLocaleString()} tok
          </span>
        </div>

        <div className="flex items-baseline gap-1.5">
          <span className="text-foreground text-lg font-semibold tabular-nums">
            {credits.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
          <span className="text-muted-foreground text-[11px]">credit</span>
        </div>

        <div className="mt-1 flex flex-col gap-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted flex cursor-pointer">
                  {totalTokens > 0 ? (
                    <>
                      <div
                        style={{ width: `${inputPct}%` }}
                        className="bg-primary h-full transition-all duration-300"
                      />
                      <div
                        style={{ width: `${outputPct}%` }}
                        className="bg-emerald-500/80 h-full transition-all duration-300"
                      />
                    </>
                  ) : (
                    <div className="w-full bg-muted-foreground/15 h-full" />
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs font-mono flex flex-col gap-0.5">
                <div>
                  input: {inputTokens.toLocaleString()} tok ({inputPct.toFixed(1)}%)
                </div>
                <div>
                  output: {outputTokens.toLocaleString()} tok ({outputPct.toFixed(1)}%)
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
            <div className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-primary inline-block shrink-0" />
              <span>In: {inputTokens.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-emerald-500/80 inline-block shrink-0" />
              <span>Out: {outputTokens.toLocaleString()}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function UserRowView({ user, roles }: { user: UserRow; roles: RoleRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const remove = () => {
    start(async () => {
      const r = await jsonFetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        if (r.status === 409) {
          toast.error("cannot delete the last admin");
        } else {
          toast.error(errMsg(r.body));
        }
        return;
      }
      setConfirmingDelete(false);
      toast.success("user deleted");
      router.refresh();
    });
  };

  return (
    <tr className="border-t">
      <td className="px-3 py-2">
        <div className="flex items-center gap-2.5">
          <Avatar className="size-8 rounded-full bg-muted shrink-0">
            {user.image ? <AvatarImage src={user.image} alt={user.name || user.email} /> : null}
            <AvatarFallback className="text-xs text-muted-foreground font-medium">
              {(user.name || user.email).slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-medium leading-none text-foreground truncate">
              {user.name ?? "—"}
            </span>
            <span className="text-muted-foreground font-mono text-[11px] mt-1 truncate">
              {user.email}
            </span>
          </div>
        </div>
      </td>
      <td className="px-3 py-2">
        <Badge variant={user.roleId === "admin" ? "default" : "secondary"}>
          {user.roleName ?? user.roleId}
        </Badge>
      </td>
      <td className="px-3 py-2 text-center">
        {user.banned ? (
          <Badge variant="muted">Banned</Badge>
        ) : user.emailVerified ? (
          <Badge variant="success">Verified</Badge>
        ) : (
          <Badge variant="muted">Unverified</Badge>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex flex-col items-end tabular-nums text-xs">
          <span className="font-medium text-foreground">
            {(user.todayCredits ?? 0).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{" "}
            <span className="text-[11px] font-normal text-muted-foreground">credit</span>
          </span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-muted-foreground font-mono text-[11px] underline decoration-dotted underline-offset-2 cursor-help">
                  {(user.todayTokens ?? 0).toLocaleString()}{" "}
                  <span className="text-[10px] text-muted-foreground/70">tok</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs font-mono flex flex-col gap-0.5">
                <div>input: {(user.todayInputTokens ?? 0).toLocaleString()} tok</div>
                <div>output: {(user.todayOutputTokens ?? 0).toLocaleString()} tok</div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex flex-col items-end tabular-nums text-xs">
          <span className="font-medium text-foreground">
            {(user.totalCredits ?? 0).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{" "}
            <span className="text-[11px] font-normal text-muted-foreground">credit</span>
          </span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-muted-foreground font-mono text-[11px] underline decoration-dotted underline-offset-2 cursor-help">
                  {(user.totalTokens ?? 0).toLocaleString()}{" "}
                  <span className="text-[10px] text-muted-foreground/70">tok</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs font-mono flex flex-col gap-0.5">
                <div>input: {(user.totalInputTokens ?? 0).toLocaleString()} tok</div>
                <div>output: {(user.totalOutputTokens ?? 0).toLocaleString()} tok</div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex justify-end gap-1">
          <Button variant="outline" size="xs" onClick={() => setEditing(true)} disabled={pending}>
            Edit
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => setConfirmingDelete(true)}
            disabled={pending}
            aria-label={`Delete ${user.email}`}
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
              <DialogTitle>Delete this user?</DialogTitle>
              <DialogDescription>
                “{user.email}” and all of their sessions, accounts, and threads will be removed.
                This cannot be undone.
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

        <UserDialog
          mode="edit"
          open={editing}
          user={user}
          roles={roles}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      </td>
    </tr>
  );
}

type UserDialogProps = {
  mode: "edit";
  open: boolean;
  user: UserRow;
  roles: RoleRow[];
  onClose: () => void;
  onSaved: () => void;
};

function UserDialog(props: UserDialogProps) {
  const initialRoleId = props.user.roleId;
  const initialBanned = props.user.banned;

  const [roleId, setRoleId] = useState(initialRoleId);
  const [banned, setBanned] = useState(initialBanned);
  const [saving, start] = useTransition();

  useEffect(() => {
    setRoleId(initialRoleId);
    setBanned(initialBanned);
  }, [initialRoleId, initialBanned]);

  const save = () => {
    if (!roleId) {
      toast.error("role required");
      return;
    }
    start(async () => {
      const r = await jsonFetch(`/api/admin/users/${encodeURIComponent(props.user.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ roleId, banned }),
      });
      if (!r.ok) {
        if (r.status === 409) {
          toast.error("cannot demote or ban the last admin");
        } else if (r.status === 404) {
          toast.error("role not found");
        } else {
          toast.error(errMsg(r.body));
        }
        return;
      }
      toast.success("user updated");
      props.onSaved();
    });
  };

  return (
    <FormDialog
      open={props.open}
      onOpenChange={(o) => !o && props.onClose()}
      title={`Edit user: ${props.user.email}`}
      description="Pick a role from the list — FK is validated server-side. Banning immediately revokes every active session for this user."
      submitLabel="Save"
      pending={saving}
      onSubmit={save}
      onCancel={props.onClose}
    >
      <div className="flex flex-col gap-4">
        <div className="bg-muted/40 flex flex-col gap-1 rounded-md px-3 py-2">
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Email
          </span>
          <span className="font-mono text-xs">{props.user.email}</span>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Role</span>
          <Select value={roleId} onValueChange={setRoleId} disabled={saving}>
            <SelectTrigger>
              <SelectValue placeholder="Select role" />
            </SelectTrigger>
            <SelectContent>
              {props.roles.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {`${r.name} (${r.id})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">Banned</span>
          <Switch
            checked={banned}
            onCheckedChange={setBanned}
            disabled={saving}
            aria-label="User banned"
          />
        </label>
      </div>
    </FormDialog>
  );
}

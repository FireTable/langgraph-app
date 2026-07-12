"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Loader2 } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";

type PublicProviderApiKey = { name: string };
type PublicModel = {
  name: string;
  enabled: boolean;
  inputPer1k: number;
  outputPer1k: number;
};
type PublicProviderRow = {
  id: string;
  name: string;
  enabled: boolean;
  baseUrl: string;
  apiKeys: PublicProviderApiKey[];
  models: PublicModel[];
  createdAt: string;
  updatedAt: string;
};
type RoleRow = {
  id: string;
  name: string;
  creditLimit: number | null;
  windowHours: number;
  createdAt: string;
  updatedAt: string;
};

async function jsonFetch<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: T | { code: string; message?: string } }> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as T | { code: string; message?: string };
  return { ok: res.ok, status: res.status, body };
}

function errMsg(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const m = (body as { message?: string }).message;
    const c = (body as { code?: string }).code;
    if (m) return m;
    if (c) return c;
  }
  return "request failed";
}

export function AdminTabs({
  providers,
  roles,
}: {
  providers: PublicProviderRow[];
  roles: RoleRow[];
}) {
  return (
    <Tabs defaultValue="providers">
      <TabsList>
        <TabsTrigger value="providers">Providers</TabsTrigger>
        <TabsTrigger value="roles">Roles</TabsTrigger>
      </TabsList>
      <TabsContent value="providers">
        <ProvidersPanel initial={providers} />
      </TabsContent>
      <TabsContent value="roles">
        <RolesPanel initial={roles} />
      </TabsContent>
    </Tabs>
  );
}

function ProvidersPanel({ initial }: { initial: PublicProviderRow[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="mt-2">
          <h2 className="font-semibold">Providers</h2>
          <p className="text-muted-foreground text-xs mt-1">
            LLM providers, their base URL, models, and API keys.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAdding(true)}
        >
          Add provider
        </Button>
      </div>

      {initial.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-6 text-center text-sm">
            No providers yet.
          </CardContent>
        </Card>
      ) : (
        initial.map((p) => <ProviderCard key={p.id} provider={p} />)
      )}

      <ProviderDialog
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

function ProviderCard({ provider }: { provider: PublicProviderRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editing, setEditing] = useState(false);

  const confirmRemove = () => {
    start(async () => {
      const r = await jsonFetch(`/api/admin/providers/${encodeURIComponent(provider.id)}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        toast.error(errMsg(r.body));
        return;
      }
      setConfirmingDelete(false);
      toast.success("provider deleted");
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <CardTitle>{provider.name}</CardTitle>
              <Badge variant={provider.enabled ? "success" : "muted"}>
                {provider.enabled ? "Enabled" : "Disabled"}
              </Badge>
            </div>
            <CardDescription>
              <span className="font-mono">{provider.id}</span>
              <span className="mx-1.5">·</span>
              {new Date(provider.createdAt).toLocaleDateString("en-CA")}
            </CardDescription>
          </div>
          <div className="flex gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
              disabled={pending}
            >
              Edit
            </Button>
            {/* ponytail: the default provider is the seed row — at least
                one provider must always exist for the system to boot,
                so we hard-disable Delete on id="default". The backend
                enforces the same rule (DELETE /[id]/route returns 409
                for default) so a tampered client can't slip past. */}
            {provider.id === "default" ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0}>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled
                        aria-label="Default provider cannot be deleted"
                      >
                        Delete
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    Default provider — at least one is required.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmingDelete(true)}
                disabled={pending}
              >
                Delete
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Base URL
          </span>
          <code className="text-foreground text-xs break-all">{provider.baseUrl}</code>
        </div>
        <Separator />
        <ModelsSection providerId={provider.id} models={provider.models} />
        <Separator />
        <KeysSection providerId={provider.id} keys={provider.apiKeys} />
      </CardContent>

      <ProviderDialog
        mode="edit"
        open={editing}
        provider={provider}
        pending={pending}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          router.refresh();
        }}
      />

      <Dialog open={confirmingDelete} onOpenChange={(open) => !open && setConfirmingDelete(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this provider?</DialogTitle>
            <DialogDescription>
              “{provider.name}” and all of its models and API keys will be removed. This cannot be
              undone.
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
              onClick={() => void confirmRemove()}
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
    </Card>
  );
}

function ModelsSection({ providerId, models }: { providerId: string; models: PublicModel[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [pendingDelete, setPendingDelete] = useState<PublicModel | null>(null);
  const [editing, setEditing] = useState<PublicModel | null>(null);
  const [adding, setAdding] = useState(false);

  const confirmRemove = () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    start(async () => {
      const r = await jsonFetch(
        `/api/admin/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(target.name)}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        toast.error(errMsg(r.body));
        return;
      }
      setPendingDelete(null);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Models</h3>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => setAdding(true)}
          disabled={pending}
        >
          Add model
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-xs">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Name</th>
              <th className="px-3 py-2 text-left font-medium">Enabled</th>
              <th className="px-3 py-2 text-right font-medium">Input / 1k</th>
              <th className="px-3 py-2 text-right font-medium">Output / 1k</th>
              <th className="px-3 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {models.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted-foreground px-3 py-3 text-center text-xs">
                  No models configured.
                </td>
              </tr>
            ) : (
              models.map((m) => (
                <tr key={m.name} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{m.name}</td>
                  <td className="px-3 py-2">
                    <Badge variant={m.enabled ? "success" : "muted"}>
                      {m.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{m.inputPer1k}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{m.outputPer1k}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => setEditing(m)}
                        disabled={pending}
                        aria-label={`Edit ${m.name}`}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => setPendingDelete(m)}
                        disabled={pending}
                        aria-label={`Delete ${m.name}`}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this model?</DialogTitle>
            <DialogDescription>
              “{pendingDelete?.name}” will be removed from this provider. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="w-full md:w-auto"
              onClick={() => setPendingDelete(null)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="w-full md:w-auto"
              onClick={() => void confirmRemove()}
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

      {editing ? (
        <ModelDialog
          mode="edit"
          open={editing !== null}
          model={editing}
          providerId={providerId}
          pending={pending}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}

      <ModelDialog
        mode="add"
        open={adding}
        providerId={providerId}
        pending={pending}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          router.refresh();
        }}
      />
    </div>
  );
}

function ModelDialog(
  props:
    | {
      mode: "add";
      open: boolean;
      providerId: string;
      pending: boolean;
      onClose: () => void;
      onSaved: () => void;
    }
    | {
      mode: "edit";
      open?: boolean;
      model: PublicModel;
      providerId: string;
      pending: boolean;
      onClose: () => void;
      onSaved: () => void;
    },
) {
  const isEdit = props.mode === "edit";
  const initialName = isEdit ? props.model.name : "";
  const initialEnabled = isEdit ? props.model.enabled : true;
  const initialIn = isEdit ? String(props.model.inputPer1k) : "0.001";
  const initialOut = isEdit ? String(props.model.outputPer1k) : "0.002";

  const [name, setName] = useState(initialName);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [inputPer1k, setInputPer1k] = useState(initialIn);
  const [outputPer1k, setOutputPer1k] = useState(initialOut);
  const [saving, start] = useTransition();

  useEffect(() => {
    setName(initialName);
    setEnabled(initialEnabled);
    setInputPer1k(initialIn);
    setOutputPer1k(initialOut);
  }, [initialName, initialEnabled, initialIn, initialOut]);

  const save = () => {
    if (!name.trim()) {
      toast.error("model name required");
      return;
    }
    const inp = Number(inputPer1k);
    const out = Number(outputPer1k);
    if (!Number.isFinite(inp) || inp < 0 || !Number.isFinite(out) || out < 0) {
      toast.error("rates must be non-negative numbers");
      return;
    }
    const path = isEdit
      ? `/api/admin/providers/${encodeURIComponent(props.providerId)}/models/${encodeURIComponent(props.model.name)}`
      : `/api/admin/providers/${encodeURIComponent(props.providerId)}/models`;
    const method = isEdit ? "PATCH" : "POST";
    const body = isEdit
      ? { enabled, inputPer1k: inp, outputPer1k: out }
      : { name: name.trim(), enabled, inputPer1k: inp, outputPer1k: out };
    start(async () => {
      const r = await jsonFetch(path, { method, body: JSON.stringify(body) });
      if (!r.ok) {
        toast.error(errMsg(r.body));
        return;
      }
      toast.success(isEdit ? "model updated" : "model added");
      props.onSaved();
    });
  };

  return (
    <FormDialog
      open={isEdit ? (props.open ?? false) : props.open}
      onOpenChange={(o: boolean) => !o && props.onClose()}
      title={isEdit ? "Edit model" : "Add model"}
      description={
        isEdit
          ? `${props.model.name} — the name is the identifier and can’t be changed here. Delete + recreate to rename.`
          : "Register a new model for this provider. The name is the JSONB-array key and can’t be changed later — delete + recreate to rename."
      }
      submitLabel={isEdit ? "Save" : "Add"}
      pending={saving || props.pending}
      onSubmit={save}
      onCancel={props.onClose}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isEdit || saving || props.pending}
            placeholder="gpt-4o-mini"
            className="font-mono"
          />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">Enabled</span>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={saving || props.pending}
            aria-label="Model enabled"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Input / 1k</span>
          <Input
            type="number"
            step="0.001"
            min={0}
            value={inputPer1k}
            onChange={(e) => setInputPer1k(e.target.value)}
            disabled={saving || props.pending}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Output / 1k</span>
          <Input
            type="number"
            step="0.001"
            min={0}
            value={outputPer1k}
            onChange={(e) => setOutputPer1k(e.target.value)}
            disabled={saving || props.pending}
          />
        </label>
      </div>
    </FormDialog>
  );
}

function KeysSection({ providerId, keys }: { providerId: string; keys: PublicProviderApiKey[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [pendingDelete, setPendingDelete] = useState<PublicProviderApiKey | null>(null);
  const [editing, setEditing] = useState<PublicProviderApiKey | null>(null);
  const [adding, setAdding] = useState(false);

  const confirmRemove = () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    start(async () => {
      const r = await jsonFetch(`/api/admin/providers/${encodeURIComponent(providerId)}/keys`, {
        method: "DELETE",
        body: JSON.stringify({ name: target.name }),
      });
      if (!r.ok) {
        toast.error(errMsg(r.body));
        return;
      }
      setPendingDelete(null);
      router.refresh();
    });
  };


  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">API keys</h3>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => setAdding(true)}
          disabled={pending}
        >
          Add key
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-xs">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Key</th>
              <th className="px-3 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 ? (
              <tr>
                <td colSpan={3} className="text-muted-foreground px-3 py-3 text-center text-xs">
                  No API keys configured.
                </td>
              </tr>
            ) : (
              keys.map((k) => (
                <tr key={k.name} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{k.name}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => setEditing(k)}
                        disabled={pending}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => setPendingDelete(k)}
                        disabled={pending}
                        aria-label={`Delete ${k.name}`}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this API key?</DialogTitle>
            <DialogDescription>
              “{pendingDelete?.name}” will be removed from this provider. Requests using this key
              will start failing immediately. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="w-full md:w-auto"
              onClick={() => setPendingDelete(null)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="w-full md:w-auto"
              onClick={() => void confirmRemove()}
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

      {editing ? (
        <KeyDialog
          mode="edit"
          open={editing !== null}
          keyEntry={editing}
          providerId={providerId}
          pending={pending}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}

      <KeyDialog
        mode="add"
        open={adding}
        providerId={providerId}
        pending={pending}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          router.refresh();
        }}
      />
    </div>
  );
}

function KeyDialog(
  props:
    | {
      mode: "add";
      open: boolean;
      providerId: string;
      pending: boolean;
      onClose: () => void;
      onSaved: () => void;
    }
    | {
      mode: "edit";
      open?: boolean;
      keyEntry: PublicProviderApiKey;
      providerId: string;
      pending: boolean;
      onClose: () => void;
      onSaved: () => void;
    },
) {
  const isEdit = props.mode === "edit";

  const [plain, setPlain] = useState("");
  const [saving, start] = useTransition();

  // ponytail: re-seed `plain` on each dialog re-open so the new secret
  // field starts blank (the edit-mode hint says "required to update",
  // so a leftover from a previous attempt is misleading).
  useEffect(() => {
    setPlain("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isEdit ? props.mode === "edit" && props.keyEntry?.name : props.mode === "add" && props.open,
  ]);

  const save = () => {
    const trimmedPlain = plain.trim();
    if (!trimmedPlain) {
      toast.error("key value required");
      return;
    }
    start(async () => {
      // ponytail: both add and edit send plaintext only — the display
      // name is derived server-side from the ciphertext tail via
      // deriveKeyName (POST) or stays the same on PATCH (which keeps
      // the path-bound keyName and only re-encrypts the blob). The
      // backend's optional `name` field is left for SQL-direct edits
      // and is intentionally not exposed in the UI.
      const path = isEdit
        ? `/api/admin/providers/${encodeURIComponent(props.providerId)}/keys/${encodeURIComponent(props.keyEntry.name)}`
        : `/api/admin/providers/${encodeURIComponent(props.providerId)}/keys`;
      const method = isEdit ? "PATCH" : "POST";
      const r = await jsonFetch(path, {
        method,
        body: JSON.stringify({ plaintext: trimmedPlain }),
      });
      if (!r.ok) {
        if (r.status === 409) {
          toast.error("a key with this tail already exists");
        } else {
          toast.error(errMsg(r.body));
        }
        return;
      }
      toast.success(isEdit ? "key updated" : "key added");
      props.onSaved();
    });
  };

  return (
    <FormDialog
      open={isEdit ? (props.open ?? false) : props.open}
      onOpenChange={(o: boolean) => !o && props.onClose()}
      title={isEdit ? "Edit API key" : "Add API key"}
      description={
        isEdit
          ? "Paste the new secret — the same key entry is re-encrypted in place. The display name (derived from the ciphertext) updates automatically."
          : "Paste the key value to add it. The display name is derived from the ciphertext — both the value and the visible name are produced by the same secret."
      }
      submitLabel={isEdit ? "Save" : "Add"}
      pending={saving || props.pending}
      onSubmit={save}
      onCancel={props.onClose}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            {isEdit ? "New key value" : "Key value"}
          </span>
          <Input
            type="password"
            value={plain}
            onChange={(e) => setPlain(e.target.value)}
            disabled={saving || props.pending}
            placeholder={isEdit ? "required to update" : "sk-…xyz"}
            className="font-mono"
          />
        </label>
        {isEdit ? (
          <p className="text-muted-foreground text-xs">
            Display name <span className="font-mono">{props.keyEntry.name}</span> is derived
            from the key value — paste the new secret to regenerate.
          </p>
        ) : null}
      </div>
    </FormDialog>
  );
}

function RolesPanel({ initial }: { initial: RoleRow[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="mt-2">
          <h2 className="font-semibold">Roles</h2>
          <p className="text-muted-foreground text-xs mt-1">
            Roles set the per-window credit cap for users. A blank credit limit means
            unlimited.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAdding(true)}
        >
          Add role
        </Button>
      </div>


      <Card>

        <CardContent>
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
        </CardContent>
      </Card>

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

// ponytail: provider add + edit share fields (display name, enabled,
// baseUrl). Mode flips the title, submit label, and whether the auto-
// generated id is shown. `id` is the DB primary key — PATCH doesn't
// accept a rename, so the edit dialog locks it. Add mode hides it
// entirely (server picks one from `crypto.randomUUID()`).
type ProviderDialogProps =
  | {
    mode: "add";
    open: boolean;
    onClose: () => void;
    onSaved: () => void;
  }
  | {
    mode: "edit";
    open?: boolean;
    provider: PublicProviderRow;
    pending: boolean;
    onClose: () => void;
    onSaved: () => void;
  };

function ProviderDialog(props: ProviderDialogProps) {
  const isEdit = props.mode === "edit";
  const initialName = isEdit ? props.provider.name : "";
  const initialEnabled = isEdit ? props.provider.enabled : true;
  const initialBaseUrl = isEdit ? props.provider.baseUrl : "";

  const [name, setName] = useState(initialName);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [saving, start] = useTransition();

  useEffect(() => {
    setName(initialName);
    setEnabled(initialEnabled);
    setBaseUrl(initialBaseUrl);
  }, [initialName, initialEnabled, initialBaseUrl]);

  const save = () => {
    if (!name.trim()) {
      toast.error("display name is required");
      return;
    }
    if (!baseUrl.trim()) {
      toast.error("base URL is required");
      return;
    }
    try {
      // ponytail: trust the user but validate the URL parses — admin
      // will hit 4xx from the upstream if they paste a typo, but a
      // frontend check keeps the error next to the field.
      // eslint-disable-next-line no-new
      new URL(baseUrl.trim());
    } catch {
      toast.error("base URL must be a valid URL");
      return;
    }
    start(async () => {
      let r;
      if (isEdit) {
        r = await jsonFetch(
          `/api/admin/providers/${encodeURIComponent(props.provider.id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              name: name.trim(),
              enabled,
              baseUrl: baseUrl.trim(),
            }),
          },
        );
      } else {
        // ponytail: id is auto-generated server-side — we send a UUID
        // with a "prov_" prefix so the URL space is unmistakable.
        // Collisions are astronomically unlikely but POST returns 409
        // with a "DUPLICATE" code if it ever happens; the toast
        // surfaces that as a fallback.
        const newId = `prov_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
        r = await jsonFetch("/api/admin/providers", {
          method: "POST",
          body: JSON.stringify({
            id: newId,
            name: name.trim(),
            enabled,
            baseUrl: baseUrl.trim(),
          }),
        });
      }
      if (!r.ok) {
        if (r.status === 409) {
          toast.error("a provider with this id already exists");
        } else {
          toast.error(errMsg(r.body));
        }
        return;
      }
      toast.success(isEdit ? "provider updated" : "provider created");
      props.onSaved();
    });
  };

  return (
    <FormDialog
      open={isEdit ? (props.open ?? false) : props.open}
      onOpenChange={(o: boolean) => !o && props.onClose()}
      title={isEdit ? "Edit provider" : "Add provider"}
      description={
        isEdit
          ? `ID ${props.provider.id} is the FK identifier and can’t be changed here. Delete + recreate to rename.`
          : "Register a new LLM provider. The id is auto-generated; provide a display name, enabled toggle, and base URL."
      }
      submitLabel={isEdit ? "Save" : "Add"}
      pending={saving || (isEdit ? props.pending : false)}
      onSubmit={save}
      onCancel={props.onClose}
    >
      <div className="flex flex-col gap-4">
        {isEdit ? (
          <div className="bg-muted/40 flex flex-col gap-1 rounded-md px-3 py-2">
            <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              ID
            </span>
            <span className="font-mono text-xs">{props.provider.id}</span>
          </div>
        ) : null}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Display name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={saving || (isEdit ? props.pending : false)}
            placeholder="OpenAI"
          />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">Enabled</span>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={saving || (isEdit ? props.pending : false)}
            aria-label="Provider enabled"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Base URL</span>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            disabled={saving || (isEdit ? props.pending : false)}
            placeholder="https://api.openai.com/v1"
            className="font-mono"
          />
        </label>
      </div>
    </FormDialog>
  );
}

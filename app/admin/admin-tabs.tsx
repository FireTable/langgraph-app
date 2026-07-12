"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Loader2 } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const [pending, start] = useTransition();
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");

  const create = () => {
    if (!newId.trim() || !newName.trim()) {
      toast.error("id and name are required");
      return;
    }
    start(async () => {
      const r = await jsonFetch("/api/admin/providers", {
        method: "POST",
        body: JSON.stringify({ id: newId.trim(), name: newName.trim(), enabled: true }),
      });
      if (!r.ok) {
        toast.error(errMsg(r.body));
        return;
      }
      setNewId("");
      setNewName("");
      toast.success("provider created");
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="border-dashed bg-muted/20">
        <CardHeader>
          <CardTitle>New Provider</CardTitle>
          <CardDescription>
            Add a new provider to the system.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Input
            className="flex-1"
            placeholder="Provider id (e.g. openai)"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            disabled={pending}
            aria-label="New provider id"
          />
          <Input
            className="flex-1"
            placeholder="Display name (e.g. OpenAI)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            disabled={pending}
            aria-label="New provider name"
          />
          <Button onClick={create} disabled={pending}>
            Create
          </Button>
        </CardContent>
      </Card>

      {initial.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-6 text-center text-sm">
            No providers yet.
          </CardContent>
        </Card>
      ) : (
        initial.map((p) => <ProviderCard key={p.id} provider={p} />)
      )}
    </div>
  );
}

function ProviderCard({ provider }: { provider: PublicProviderRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editingBaseUrl, setEditingBaseUrl] = useState(false);
  const [baseUrlDraft, setBaseUrlDraft] = useState(provider.baseUrl);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const saveBaseUrl = () => {
    if (!baseUrlDraft.trim()) {
      toast.error("baseUrl is required");
      return;
    }
    start(async () => {
      const r = await jsonFetch(`/api/admin/providers/${encodeURIComponent(provider.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ baseUrl: baseUrlDraft.trim() }),
      });
      if (!r.ok) {
        toast.error(errMsg(r.body));
        return;
      }
      setEditingBaseUrl(false);
      toast.success("baseUrl updated");
      router.refresh();
    });
  };

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
          <div>
            <CardTitle>{provider.name}</CardTitle>
            <CardDescription>
              id: <span className="font-mono">{provider.id}</span> ·{" "}
              {provider.enabled ? "enabled" : "disabled"}
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setConfirmingDelete(true)}
            disabled={pending}
          >
            Delete
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Base URL</h3>
          {editingBaseUrl ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Input
                value={baseUrlDraft}
                onChange={(e) => setBaseUrlDraft(e.target.value)}
                disabled={pending}
                placeholder="https://api.openai.com/v1"
              />
              <div className="flex gap-1">
                <Button size="sm" onClick={saveBaseUrl} disabled={pending}>
                  Save
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setBaseUrlDraft(provider.baseUrl);
                    setEditingBaseUrl(false);
                  }}
                  disabled={pending}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <code className="text-muted-foreground text-xs">{provider.baseUrl}</code>
              <Button
                variant="outline"
                size="xs"
                onClick={() => setEditingBaseUrl(true)}
                disabled={pending}
              >
                Edit
              </Button>
            </div>
          )}
        </div>
        <Separator />
        <ModelsSection providerId={provider.id} models={provider.models} />
        <Separator />
        <KeysSection providerId={provider.id} keys={provider.apiKeys} />
      </CardContent>

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
  const [name, setName] = useState("");
  const [inputPer1k, setInputPer1k] = useState("0.001");
  const [outputPer1k, setOutputPer1k] = useState("0.002");
  const [pendingDelete, setPendingDelete] = useState<PublicModel | null>(null);

  const add = () => {
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
    start(async () => {
      const r = await jsonFetch(`/api/admin/providers/${encodeURIComponent(providerId)}/models`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          enabled: true,
          inputPer1k: inp,
          outputPer1k: out,
        }),
      });
      if (!r.ok) {
        toast.error(errMsg(r.body));
        return;
      }
      setName("");
      toast.success("model added");
      router.refresh();
    });
  };

  const toggle = (m: PublicModel, enabled: boolean) => {
    start(async () => {
      const r = await jsonFetch(
        `/api/admin/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(m.name)}`,
        { method: "PATCH", body: JSON.stringify({ enabled }) },
      );
      if (!r.ok) {
        toast.error(errMsg(r.body));
        return;
      }
      router.refresh();
    });
  };

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
      <h3 className="text-sm font-medium">Models</h3>
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
                    <button
                      type="button"
                      className="text-xs underline"
                      onClick={() => toggle(m, !m.enabled)}
                      disabled={pending}
                    >
                      {m.enabled ? "Yes" : "No"}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{m.inputPer1k}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{m.outputPer1k}</td>
                  <td className="px-3 py-2 text-right">
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
                  </td>
                </tr>
              ))
            )}
            <tr className="border-t">
              <td className="px-3 py-1.5">
                <Input
                  placeholder="gpt-4o-mini"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={pending}
                  className="h-5 px-1.5 font-mono text-[11px]"
                  aria-label="New model name"
                />
              </td>
              <td className="text-muted-foreground px-3 py-1.5 text-center text-xs">—</td>
              <td className="px-3 py-1.5">
                <Input
                  placeholder="input / 1k"
                  value={inputPer1k}
                  onChange={(e) => setInputPer1k(e.target.value)}
                  disabled={pending}
                  className="h-5 px-1.5 text-right font-mono text-[11px]"
                  aria-label="New model input rate"
                />
              </td>
              <td className="px-3 py-1.5">
                <Input
                  placeholder="output / 1k"
                  value={outputPer1k}
                  onChange={(e) => setOutputPer1k(e.target.value)}
                  disabled={pending}
                  className="h-5 px-1.5 text-right font-mono text-[11px]"
                  aria-label="New model output rate"
                />
              </td>
              <td className="px-3 py-2 text-right">
                <Button
                  type="button"
                  size="xs"
                  onClick={add}
                  disabled={pending}
                  aria-label="Add model"
                >
                  Add
                </Button>
              </td>
            </tr>
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
    </div>
  );
}

function KeysSection({ providerId, keys }: { providerId: string; keys: PublicProviderApiKey[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [plain, setPlain] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PublicProviderApiKey | null>(null);

  const add = () => {
    if (!plain.trim()) {
      toast.error("api key required");
      return;
    }
    start(async () => {
      const r = await jsonFetch(`/api/admin/providers/${encodeURIComponent(providerId)}/keys`, {
        method: "POST",
        body: JSON.stringify({ plaintext: plain }),
      });
      if (!r.ok) {
        toast.error(errMsg(r.body));
        return;
      }
      setPlain("");
      toast.success("key added");
      router.refresh();
    });
  };

  const rotate = (k: PublicProviderApiKey) => {
    const next = window.prompt(`Rotate ${k.name} — paste the new key value`);
    if (!next) return;
    start(async () => {
      const r = await jsonFetch(
        `/api/admin/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(k.name)}`,
        { method: "PATCH", body: JSON.stringify({ plaintext: next }) },
      );
      if (!r.ok) {
        toast.error(errMsg(r.body));
        return;
      }
      toast.success("key rotated");
      router.refresh();
    });
  };

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
      <h3 className="text-sm font-medium">API keys</h3>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-xs">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Name</th>
              <th className="px-3 py-2 text-right font-medium">Created</th>
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
                  <td className="text-muted-foreground px-3 py-2 text-right text-xs">—</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => rotate(k)}
                        disabled={pending}
                      >
                        Rotate
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
            <tr className="border-t">
              <td colSpan={2} className="px-3 py-1.5">
                <Input
                  type="password"
                  placeholder="sk-…xyz"
                  value={plain}
                  onChange={(e) => setPlain(e.target.value)}
                  disabled={pending}
                  className="h-5 px-1.5 font-mono text-[11px]"
                  aria-label="New API key"
                />
              </td>
              <td className="px-3 py-1.5 text-right">
                <Button
                  type="button"
                  size="xs"
                  onClick={add}
                  disabled={pending}
                  aria-label="Add API key"
                >
                  Add
                </Button>
              </td>
            </tr>
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
    </div>
  );
}

function RolesPanel({ initial }: { initial: RoleRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [limit, setLimit] = useState("");
  const [hours, setHours] = useState("24");

  const create = () => {
    if (!id.trim() || !name.trim()) {
      toast.error("id and name required");
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
      const r = await jsonFetch("/api/admin/roles", {
        method: "POST",
        body: JSON.stringify({
          id: id.trim(),
          name: name.trim(),
          creditLimit: limitNum,
          windowHours: h,
        }),
      });
      if (!r.ok) {
        toast.error(errMsg(r.body));
        return;
      }
      setId("");
      setName("");
      setLimit("");
      setHours("24");
      toast.success("role created");
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Roles</CardTitle>
          <CardDescription>
            Roles set the per-window credit cap for users. A blank credit limit means unlimited.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground text-xs">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Id</th>
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
                <tr className="border-t">
                  <td className="px-3 py-1.5">
                    <Input
                      placeholder="editor"
                      value={id}
                      onChange={(e) => setId(e.target.value)}
                      disabled={pending}
                      className="h-5 px-1.5 font-mono text-[11px]"
                      aria-label="New role id"
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <Input
                      placeholder="Editor"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={pending}
                      className="h-5 px-1.5 text-[11px]"
                      aria-label="New role name"
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <Input
                      placeholder="blank = unlimited"
                      value={limit}
                      onChange={(e) => setLimit(e.target.value)}
                      disabled={pending}
                      className="h-5 px-1.5 text-right font-mono text-[11px]"
                      aria-label="New role credit limit"
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <Input
                      type="number"
                      min={1}
                      value={hours}
                      onChange={(e) => setHours(e.target.value)}
                      disabled={pending}
                      className="h-5 px-1.5 text-right font-mono text-[11px]"
                      aria-label="New role window hours"
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Button size="xs" onClick={create} disabled={pending} aria-label="Add role">
                      Add
                    </Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RoleRowView({ role }: { role: RoleRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(role.name);
  const [limit, setLimit] = useState(role.creditLimit === null ? "" : String(role.creditLimit));
  const [hours, setHours] = useState(String(role.windowHours));
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const save = () => {
    const h = Number(hours);
    if (!Number.isInteger(h) || h < 1) {
      toast.error("windowHours must be a positive integer");
      return;
    }
    const limitNum = limit.trim() === "" ? null : Number(limit);
    if (limitNum !== null && (!Number.isFinite(limitNum) || limitNum < 0)) {
      toast.error("creditLimit must be non-negative or blank");
      return;
    }
    start(async () => {
      const r = await jsonFetch(`/api/admin/roles/${encodeURIComponent(role.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), creditLimit: limitNum, windowHours: h }),
      });
      if (!r.ok) {
        toast.error(errMsg(r.body));
        return;
      }
      setEditing(false);
      toast.success("role updated");
      router.refresh();
    });
  };

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

  if (editing) {
    return (
      <tr className="border-t">
        <td className="px-3 py-2 font-mono text-xs">{role.id}</td>
        <td className="px-3 py-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={pending} />
        </td>
        <td className="px-3 py-2">
          <Input
            placeholder="blank = unlimited"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            disabled={pending}
          />
        </td>
        <td className="px-3 py-2">
          <Input
            type="number"
            min={1}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            disabled={pending}
          />
        </td>
        <td className="px-3 py-2 text-right">
          <div className="flex justify-end gap-1">
            <Button size="xs" onClick={save} disabled={pending}>
              Save
            </Button>
            <Button variant="outline" size="xs" onClick={() => setEditing(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </td>
      </tr>
    );
  }

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
    </tr>
  );
}

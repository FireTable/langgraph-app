"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Switch } from "@/components/ui/switch";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";

import {
  type PublicProviderRow,
  type PublicProviderApiKey,
  type PublicModel,
  type ModelKind,
  DEFAULT_KIND,
  jsonFetch,
  errMsg,
} from "@/app/admin/types";

export function ProvidersPanel({ initial }: { initial: PublicProviderRow[] }) {
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
        <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
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
  const [collapsed, setCollapsed] = useState(false);

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
    <Card className={`py-0 gap-0 ${provider.enabled ? undefined : "bg-muted/40"}`}>
      <CardHeader className={collapsed ? "p-6" : "pt-6 px-6 pb-3"}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <CardTitle>{provider.name}</CardTitle>
              <Badge variant={provider.enabled ? "success" : "destructive"}>
                {provider.enabled ? "Enabled" : "Disabled"}
              </Badge>
            </div>
            <CardDescription>
              <span className="font-mono">{provider.id}</span>
              <span className="mx-1.5">·</span>
              {new Date(provider.createdAt).toLocaleDateString("en-CA")}
            </CardDescription>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
              disabled={pending}
            >
              Edit
            </Button>
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
                  <TooltipContent>Default provider — at least one is required.</TooltipContent>
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setCollapsed(!collapsed)}
              className="gap-1.5"
            >
              <span>{collapsed ? "Expand" : "Collapse"}</span>
              <ChevronDown
                className={`size-3.5 transition-transform duration-200 ${collapsed ? "-rotate-90" : "rotate-0"}`}
              />
            </Button>
          </div>
        </div>
      </CardHeader>

      <div
        className={`grid transition-all duration-300 ease-in-out ${
          collapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
        }`}
      >
        <div className="overflow-hidden">
          <CardContent className="px-6 pb-6 pt-0 flex flex-col gap-6">
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                Base URL
              </span>
              <span className="font-mono text-xs">{provider.baseUrl}</span>
            </div>

            <ModelsTable providerId={provider.id} models={provider.models} />
            <ApiKeysTable providerId={provider.id} keys={provider.apiKeys} />
          </CardContent>
        </div>
      </div>

      <ProviderDialog
        mode="edit"
        provider={provider}
        open={editing}
        pending={pending}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          router.refresh();
        }}
      />

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete provider {provider.name}?</DialogTitle>
            <DialogDescription>
              This will remove the provider <span className="font-mono">{provider.id}</span> and all
              its API keys and model rate settings. Calls using this provider will fail immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmingDelete(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmRemove} disabled={pending}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ModelsTable({ providerId, models }: { providerId: string; models: PublicModel[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editingModel, setEditingModel] = useState<PublicModel | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
          Models & Rates ({models.length})
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
          Add model
        </Button>
      </div>

      <div className="border-border/60 overflow-x-auto rounded-md border">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/50 text-muted-foreground border-b font-medium">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Pools</th>
              <th className="px-3 py-2 text-right">Input (cr/1k)</th>
              <th className="px-3 py-2 text-right">Output (cr/1k)</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {models.map((m) => (
              <tr key={m.name}>
                <td className="px-3 py-2 font-mono font-medium">{m.name}</td>
                <td className="px-3 py-2">
                  <Badge variant={m.enabled ? "success" : "destructive"}>
                    {m.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {(m.kind ?? DEFAULT_KIND).map((k) => (
                      <Badge key={k} variant="secondary" className="font-mono text-[10px]">
                        {k}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-right font-mono">{m.inputPer1k}</td>
                <td className="px-3 py-2 text-right font-mono">{m.outputPer1k}</td>
                <td className="px-3 py-2 text-right">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => setEditingModel(m)}
                  >
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ModelDialog
        mode="add"
        providerId={providerId}
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          router.refresh();
        }}
      />

      <ModelDialog
        mode="edit"
        providerId={providerId}
        model={editingModel}
        open={Boolean(editingModel)}
        onClose={() => setEditingModel(null)}
        onSaved={() => {
          setEditingModel(null);
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
        providerId: string;
        open: boolean;
        onClose: () => void;
        onSaved: () => void;
      }
    | {
        mode: "edit";
        providerId: string;
        model: PublicModel | null;
        open: boolean;
        onClose: () => void;
        onSaved: () => void;
      },
) {
  const isEdit = props.mode === "edit";

  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [inputPer1k, setInputPer1k] = useState("0");
  const [outputPer1k, setOutputPer1k] = useState("0");
  const [kind, setKind] = useState<ModelKind[]>(DEFAULT_KIND);
  const [saving, start] = useTransition();

  const initialName = isEdit ? props.model?.name : "";
  const initialEnabled = isEdit ? (props.model?.enabled ?? true) : true;
  const initialInput = isEdit ? String(props.model?.inputPer1k ?? 0) : "0";
  const initialOutput = isEdit ? String(props.model?.outputPer1k ?? 0) : "0";
  const initialKind = isEdit ? (props.model?.kind ?? DEFAULT_KIND) : DEFAULT_KIND;

  useEffect(() => {
    if (isEdit && props.model) {
      setName(initialName ?? "");
      setEnabled(initialEnabled);
      setInputPer1k(initialInput);
      setOutputPer1k(initialOutput);
      setKind(initialKind);
    } else if (!isEdit && props.open) {
      setName("");
      setEnabled(true);
      setInputPer1k("0");
      setOutputPer1k("0");
      setKind(DEFAULT_KIND);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isEdit ? props.mode === "edit" && props.model?.name : props.mode === "add" && props.open,
    initialName,
    initialEnabled,
    initialInput,
    initialOutput,
    initialKind,
  ]);

  const toggleKind = (k: ModelKind) => {
    setKind((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  };

  const save = () => {
    const parsedIn = parseFloat(inputPer1k);
    const parsedOut = parseFloat(outputPer1k);
    if (!name.trim()) {
      toast.error("model name required");
      return;
    }
    if (isNaN(parsedIn) || parsedIn < 0 || isNaN(parsedOut) || parsedOut < 0) {
      toast.error("token rates must be non-negative numbers");
      return;
    }
    if (kind.length === 0) {
      toast.error("at least one model kind is required");
      return;
    }
    start(async () => {
      const path = isEdit
        ? `/api/admin/providers/${encodeURIComponent(props.providerId)}/models/${encodeURIComponent(props.model?.name ?? "")}`
        : `/api/admin/providers/${encodeURIComponent(props.providerId)}/models`;
      const method = isEdit ? "PATCH" : "POST";
      const r = await jsonFetch(path, {
        method,
        body: JSON.stringify({
          name: name.trim(),
          enabled,
          inputPer1k: parsedIn,
          outputPer1k: parsedOut,
          kind,
        }),
      });
      if (!r.ok) {
        if (r.status === 409) {
          toast.error("a model with this name already exists");
        } else {
          toast.error(errMsg(r.body));
        }
        return;
      }
      toast.success(isEdit ? "model updated" : "model added");
      props.onSaved();
    });
  };

  return (
    <FormDialog
      open={isEdit ? props.open && Boolean(props.model) : props.open}
      onOpenChange={(o: boolean) => !o && props.onClose()}
      title={isEdit ? "Edit model rate" : "Add model"}
      description={
        isEdit
          ? "Update rates, enabled state, or capability pools for this model."
          : "Register a model under this provider. Set its cost per 1k input/output tokens (in credits) and which pools it serves."
      }
      submitLabel={isEdit ? "Save" : "Add"}
      pending={saving}
      onSubmit={save}
      onCancel={props.onClose}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Model name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={saving}
            placeholder="gpt-4o-mini"
            className="font-mono"
          />
        </label>

        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">Enabled</span>
          <Switch checked={enabled} onCheckedChange={setEnabled} disabled={saving} />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Capability pools (kind)</span>
          <p className="text-muted-foreground text-xs">
            Determines which tasks reach this model. Chat is standard reasoning; OCR is PDF vision
            page-to-markdown; Embed is dense vector; Extract is structured-output triples; Eval is
            LLM-as-a-Judge; Pic is canvas image generation (fal.ai-backed).
          </p>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {(["chat", "ocr", "embed", "extract", "rerank", "eval", "pic"] as ModelKind[]).map(
              (k) => (
                <label
                  key={k}
                  className="bg-muted/30 border-border/60 hover:bg-muted/60 flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-xs"
                >
                  <Checkbox
                    checked={kind.includes(k)}
                    onCheckedChange={() => toggleKind(k)}
                    disabled={saving}
                  />
                  <span className="font-mono font-medium">{k}</span>
                </label>
              ),
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Input (cr / 1k)</span>
            <Input
              type="number"
              step="any"
              min="0"
              value={inputPer1k}
              onChange={(e) => setInputPer1k(e.target.value)}
              disabled={saving}
              className="font-mono"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Output (cr / 1k)</span>
            <Input
              type="number"
              step="any"
              min="0"
              value={outputPer1k}
              onChange={(e) => setOutputPer1k(e.target.value)}
              disabled={saving}
              className="font-mono"
            />
          </label>
        </div>
      </div>
    </FormDialog>
  );
}

function ApiKeysTable({ providerId, keys }: { providerId: string; keys: PublicProviderApiKey[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editingKey, setEditingKey] = useState<PublicProviderApiKey | null>(null);
  const [deletingKey, setDeletingKey] = useState<PublicProviderApiKey | null>(null);
  const [pending, start] = useTransition();

  const confirmDeleteKey = () => {
    if (!deletingKey) return;
    start(async () => {
      const r = await jsonFetch(
        `/api/admin/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(deletingKey.name)}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        toast.error(errMsg(r.body));
        return;
      }
      setDeletingKey(null);
      toast.success("key deleted");
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
          API Keys ({keys.length})
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
          Add key
        </Button>
      </div>

      <div className="border-border/60 overflow-x-auto rounded-md border">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/50 text-muted-foreground border-b font-medium">
            <tr>
              <th className="px-3 py-2">Display Name (ciphertext tail)</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {keys.map((k) => (
              <tr key={k.name}>
                <td className="px-3 py-2 font-mono font-medium">{k.name}</td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => setEditingKey(k)}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => setDeletingKey(k)}
                    >
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {keys.length === 0 ? (
              <tr>
                <td colSpan={2} className="text-muted-foreground px-3 py-4 text-center">
                  No API keys registered. Add at least one key for this provider to serve calls.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <ApiKeyDialog
        mode="add"
        providerId={providerId}
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          router.refresh();
        }}
      />

      <ApiKeyDialog
        mode="edit"
        providerId={providerId}
        keyEntry={editingKey}
        open={Boolean(editingKey)}
        pending={pending}
        onClose={() => setEditingKey(null)}
        onSaved={() => {
          setEditingKey(null);
          router.refresh();
        }}
      />

      <Dialog open={Boolean(deletingKey)} onOpenChange={(o) => !o && setDeletingKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete API key {deletingKey?.name}?</DialogTitle>
            <DialogDescription>
              The key blob will be deleted permanently. LLM calls rotating onto this key will fail
              if no other keys remain for this provider.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeletingKey(null)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmDeleteKey}
              disabled={pending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ApiKeyDialog(
  props:
    | {
        mode: "add";
        providerId: string;
        open: boolean;
        onClose: () => void;
        onSaved: () => void;
      }
    | {
        mode: "edit";
        providerId: string;
        keyEntry: PublicProviderApiKey | null;
        open: boolean;
        pending: boolean;
        onClose: () => void;
        onSaved: () => void;
      },
) {
  const isEdit = props.mode === "edit";
  const [plain, setPlain] = useState("");
  const [saving, start] = useTransition();

  useEffect(() => {
    setPlain("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit ? props.mode === "edit" && props.keyEntry?.name : props.mode === "add" && props.open]);

  const save = () => {
    const trimmedPlain = plain.trim();
    if (!trimmedPlain) {
      toast.error("key value required");
      return;
    }
    start(async () => {
      const path = isEdit
        ? `/api/admin/providers/${encodeURIComponent(props.providerId)}/keys/${encodeURIComponent(props.keyEntry?.name ?? "")}`
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
      open={isEdit ? props.open && Boolean(props.keyEntry) : props.open}
      onOpenChange={(o: boolean) => !o && props.onClose()}
      title={isEdit ? "Edit API key" : "Add API key"}
      description={
        isEdit
          ? "Paste the new secret — the same key entry is re-encrypted in place. The display name (derived from the ciphertext) updates automatically."
          : "Paste the key value to add it. The display name is derived from the ciphertext — both the value and the visible name are produced by the same secret."
      }
      submitLabel={isEdit ? "Save" : "Add"}
      pending={saving || (isEdit ? props.pending : false)}
      onSubmit={save}
      onCancel={props.onClose}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{isEdit ? "New key value" : "Key value"}</span>
          <Input
            type="password"
            value={plain}
            onChange={(e) => setPlain(e.target.value)}
            disabled={saving || (isEdit ? props.pending : false)}
            placeholder={isEdit ? "required to update" : "sk-…xyz"}
            className="font-mono"
          />
        </label>
        {isEdit && props.keyEntry ? (
          <p className="text-muted-foreground text-xs">
            Display name <span className="font-mono">{props.keyEntry.name}</span> is derived from
            the key value — paste the new secret to regenerate.
          </p>
        ) : null}
      </div>
    </FormDialog>
  );
}

export function ProviderDialog(
  props:
    | {
        mode: "add";
        open: boolean;
        onClose: () => void;
        onSaved: () => void;
      }
    | {
        mode: "edit";
        provider: PublicProviderRow;
        open: boolean;
        pending: boolean;
        onClose: () => void;
        onSaved: () => void;
      },
) {
  const isEdit = props.mode === "edit";

  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, start] = useTransition();

  const initialName = isEdit ? props.provider.name : "";
  const initialEnabled = isEdit ? props.provider.enabled : true;
  const initialBaseUrl = isEdit ? props.provider.baseUrl : "";

  useEffect(() => {
    if (isEdit && props.provider) {
      setName(initialName);
      setEnabled(initialEnabled);
      setBaseUrl(initialBaseUrl);
    } else if (!isEdit && props.open) {
      setName("");
      setEnabled(true);
      setBaseUrl("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isEdit ? props.mode === "edit" && props.provider.id : props.mode === "add" && props.open,
    initialName,
    initialEnabled,
    initialBaseUrl,
  ]);

  const save = () => {
    if (!name.trim()) {
      toast.error("display name required");
      return;
    }
    if (!baseUrl.trim()) {
      toast.error("base URL required");
      return;
    }
    start(async () => {
      let r: { ok: boolean; status: number; body: unknown };
      if (isEdit) {
        r = await jsonFetch(`/api/admin/providers/${encodeURIComponent(props.provider.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: name.trim(),
            enabled,
            baseUrl: baseUrl.trim(),
          }),
        });
      } else {
        r = await jsonFetch("/api/admin/providers", {
          method: "POST",
          body: JSON.stringify({
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

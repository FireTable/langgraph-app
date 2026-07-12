"use client";

import * as React from "react";

import { Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// ponytail: admin forms share the same chrome — Dialog + Header +
// Footer with Cancel/Submit. Different forms just plug in their
// fields as children. `submit` runs after the form's own validation
// passes (each form owns its toast-on-error UX). `pending` is the
// shared request-in-flight flag, exposed to children so individual
// fields can disable themselves without prop-drilling.
//
// open / onOpenChange: parent's visibility state. We intentionally
// don't reset internal form state here — each form resets via
// useEffect on `open` so the lifecycle stays visible to the caller.
type FormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  submitLabel: string;
  pending: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  children: React.ReactNode;
};

function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
  children,
}: FormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button
            variant="outline"
            className="w-full md:w-auto"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            className="w-full md:w-auto"
            onClick={onSubmit}
            disabled={pending}
            aria-busy={pending}
          >
            {pending ? (
              <>
                <Loader2 className="animate-spin" aria-hidden />
                Saving…
              </>
            ) : (
              submitLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { FormDialog };
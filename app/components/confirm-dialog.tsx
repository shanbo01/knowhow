"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type ConfirmDialogTone = "default" | "danger";

export type ConfirmDialogRequest = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
};

export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  onClose,
  onConfirm,
}: ConfirmDialogRequest & {
  onClose: () => void;
  onConfirm: () => void;
}) {
  const confirmed = useRef(false);

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !confirmed.current) onClose();
      }}
    >
      <AlertDialogContent
        className={tone === "danger" ? "danger-confirm-card" : "kh-dialog-content"}
      >
        <AlertDialogHeader>
          {tone === "danger" ? <p className="eyebrow">Permanent action</p> : null}
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={tone === "danger" ? "destructive" : "default"}
            onClick={() => {
              confirmed.current = true;
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function useConfirmDialog() {
  const [request, setRequest] = useState<ConfirmDialogRequest | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  useEffect(() => {
    return () => {
      resolver.current?.(false);
      resolver.current = null;
    };
  }, []);

  function settle(value: boolean) {
    resolver.current?.(value);
    resolver.current = null;
    setRequest(null);
  }

  function askToConfirm(next: ConfirmDialogRequest) {
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setRequest(next);
    });
  }

  const dialog: ReactNode = request ? (
    <ConfirmDialog
      {...request}
      onClose={() => settle(false)}
      onConfirm={() => settle(true)}
    />
  ) : null;

  return { askToConfirm, dialog };
}

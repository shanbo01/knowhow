"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function GuideDeleteDialog({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const confirmed = confirmation.trim().toLowerCase() === "delete";

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent className="danger-confirm-card">
        <AlertDialogHeader>
          <AlertDialogMedia className="danger-confirm-icon"><Trash2 /></AlertDialogMedia>
          <p className="eyebrow">Permanent action</p>
          <AlertDialogTitle>Delete this guide?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes every revision and stored screenshot. It cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="field danger-confirm-field">
          <span>Type <strong>delete</strong> to confirm</span>
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy || !confirmed}
            onClick={() => void onConfirm().catch(() => undefined)}
          >
            <Trash2 /> Delete guide
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";

export function GuideDeleteDialog({
  title,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const confirmed = confirmation === title;

  return (
    <div className="danger-confirm-backdrop" role="presentation">
      <section
        className="danger-confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-guide-title"
        aria-describedby="delete-guide-description"
      >
        <span className="danger-confirm-icon"><Trash2 /></span>
        <p className="eyebrow">Permanent action</p>
        <h2 id="delete-guide-title">Delete this guide?</h2>
        <p id="delete-guide-description">
          This permanently deletes every revision and stored screenshot. It cannot be undone.
        </p>
        <label className="field danger-confirm-field">
          <span>Type <strong>{title}</strong> to confirm</span>
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <footer>
          <button className="button secondary" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button
            className="button danger-button"
            type="button"
            disabled={busy || !confirmed}
            onClick={() => void onConfirm().catch(() => undefined)}
          >
            <Trash2 /> Delete guide
          </button>
        </footer>
      </section>
    </div>
  );
}

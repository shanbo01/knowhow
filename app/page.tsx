"use client";

import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowLeft,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Cloud,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileKey,
  HardDrive,
  KeyRound,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type RefObject,
} from "react";
import type { Models } from "appwrite";
import { AuthGate, WorkspaceSetup, type BackendState } from "./components/auth-gate";
import {
  account,
  AppwriteException,
  client,
  ID,
  Query,
  realtime,
  teams,
} from "@/lib/appwrite";
import { decryptSecretValue, encryptSecretValue } from "@/lib/crypto";
import type {
  Actor,
  AssetPayload,
  AuditPayload,
  ClientPayload,
  RecordKind,
  RunbookPayload,
  RunbookStep,
  RunPayload,
  SecretPayload,
  VendorPayload,
} from "@/lib/domain";
import {
  createAuditRecord,
  createRecord,
  humanizeAppwriteError,
  listRecords,
  updateRecord,
  type StoredRecord,
} from "@/lib/records";

type View =
  | "Overview"
  | "Runbooks"
  | "Assets"
  | "Secrets"
  | "Vendors"
  | "Clients"
  | "Activity";

type EditableKind = "client" | "runbook" | "asset" | "vendor" | "secret";

type AnyRecord = {
  [K in RecordKind]: StoredRecord<K>;
}[RecordKind];

type EditorState = {
  kind: EditableKind;
  record?: AnyRecord;
};

type LayerState =
  | { type: "editor"; editor: EditorState }
  | { type: "import" }
  | { type: "invite" }
  | { type: "unlock"; secret: StoredRecord<"secret"> }
  | null;

type RevealedSecret = {
  value: string;
  expiresAt: number;
};

type EditorDraft = {
  title: string;
  code: string;
  status: string;
  notes: string;
  tags: string;
  address: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  category: string;
  summary: string;
  estimatedMinutes: string;
  verifiedAt: string;
  reviewDueAt: string;
  assetType: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  hostname: string;
  ipAddress: string;
  assignedTo: string;
  location: string;
  warrantyExpiresAt: string;
  supportUrl: string;
  accountNumber: string;
  renewalDate: string;
  noticeDays: string;
  secretType: string;
  username: string;
  url: string;
  value: string;
  passphrase: string;
  passphraseConfirmation: string;
  expiresAt: string;
};

type AssetImport = {
  title: string;
  code: string;
  payload: AssetPayload;
  searchText: string;
};

const PRIMARY_NAV: Array<{ label: View; icon: LucideIcon }> = [
  { label: "Overview", icon: Database },
  { label: "Runbooks", icon: BookOpen },
  { label: "Assets", icon: HardDrive },
  { label: "Secrets", icon: KeyRound },
  { label: "Vendors", icon: Users },
];

const VIEW_KIND: Partial<Record<View, RecordKind>> = {
  Runbooks: "runbook",
  Assets: "asset",
  Secrets: "secret",
  Vendors: "vendor",
  Clients: "client",
  Activity: "audit",
};

const KIND_VIEW: Partial<Record<RecordKind, View>> = {
  runbook: "Runbooks",
  asset: "Assets",
  secret: "Secrets",
  vendor: "Vendors",
  client: "Clients",
  audit: "Activity",
};

const KIND_LABEL: Record<EditableKind, string> = {
  client: "Client",
  runbook: "Runbook",
  asset: "Asset",
  vendor: "Vendor",
  secret: "Secret",
};

const KIND_ICON: Record<EditableKind, LucideIcon> = {
  client: Users,
  runbook: BookOpen,
  asset: HardDrive,
  vendor: Server,
  secret: FileKey,
};

const DEFAULT_DRAFT: EditorDraft = {
  title: "",
  code: "",
  status: "",
  notes: "",
  tags: "",
  address: "",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  category: "",
  summary: "",
  estimatedMinutes: "",
  verifiedAt: "",
  reviewDueAt: "",
  assetType: "",
  manufacturer: "",
  model: "",
  serialNumber: "",
  hostname: "",
  ipAddress: "",
  assignedTo: "",
  location: "",
  warrantyExpiresAt: "",
  supportUrl: "",
  accountNumber: "",
  renewalDate: "",
  noticeDays: "",
  secretType: "password",
  username: "",
  url: "",
  value: "",
  passphrase: "",
  passphraseConfirmation: "",
  expiresAt: "",
};

function isKind<K extends RecordKind>(
  record: AnyRecord,
  kind: K,
): record is Extract<AnyRecord, { kind: K }> {
  return record.kind === kind;
}

function trimOrUndefined(value: string) {
  const clean = value.trim();
  return clean || undefined;
}

function splitTags(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toDateInput(value?: string) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function formatDate(value?: string, includeTime = false) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(includeTime
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : {}),
  }).format(parsed);
}

function relativeTime(value: string, now: number) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || now <= 0) return "—";
  const delta = timestamp - now;
  const absolute = Math.abs(delta);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (absolute < 60_000) return formatter.format(Math.round(delta / 1_000), "second");
  if (absolute < 3_600_000) return formatter.format(Math.round(delta / 60_000), "minute");
  if (absolute < 86_400_000) return formatter.format(Math.round(delta / 3_600_000), "hour");
  return formatter.format(Math.round(delta / 86_400_000), "day");
}

function initials(name?: string, email?: string) {
  const source = name?.trim() || email?.split("@")[0] || "Rivet user";
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function statusSlug(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function StatusPill({ value }: { value: string }) {
  return (
    <span className={`status-pill status-pill-${statusSlug(value)}`}>
      {value.replace(/-/g, " ")}
    </span>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="section-header">
      <div>
        <p className="coordinate">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="section-actions">{action}</div> : null}
    </header>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "empty-state empty-state-compact" : "empty-state"}>
      <span className="empty-state-icon" aria-hidden="true">
        <Icon />
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

function messageFromError(error: unknown) {
  if (error instanceof AppwriteException) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return humanizeAppwriteError(error);
}

function draftForEditor(state: EditorState): {
  draft: EditorDraft;
  steps: RunbookStep[];
} {
  const draft = { ...DEFAULT_DRAFT };
  const record = state.record;
  if (!record) {
    const defaults: Partial<Record<EditableKind, Partial<EditorDraft>>> = {
      client: { status: "active" },
      runbook: { status: "draft", estimatedMinutes: "10" },
      asset: { status: "active", assetType: "Workstation" },
      vendor: { status: "active", noticeDays: "30" },
      secret: { secretType: "password" },
    };
    return { draft: { ...draft, ...defaults[state.kind] }, steps: [] };
  }

  draft.title = record.title;
  draft.code = record.sortKey ?? "";

  if (isKind(record, "client")) {
    const payload = record.payload;
    Object.assign(draft, {
      status: payload.status,
      notes: payload.notes ?? "",
      tags: payload.tags?.join(", ") ?? "",
      address: payload.address ?? "",
      contactName: payload.primaryContact?.name ?? "",
      contactEmail: payload.primaryContact?.email ?? "",
      contactPhone: payload.primaryContact?.phone ?? "",
    });
  } else if (isKind(record, "runbook")) {
    const payload = record.payload;
    Object.assign(draft, {
      status: payload.status,
      summary: payload.summary,
      category: payload.category ?? "",
      estimatedMinutes: payload.estimatedMinutes?.toString() ?? "",
      verifiedAt: toDateInput(payload.verifiedAt),
      reviewDueAt: toDateInput(payload.reviewDueAt),
      tags: payload.tags?.join(", ") ?? "",
    });
    return { draft, steps: payload.steps.map((step) => ({ ...step })) };
  } else if (isKind(record, "asset")) {
    const payload = record.payload;
    Object.assign(draft, {
      status: payload.status,
      assetType: payload.type,
      manufacturer: payload.manufacturer ?? "",
      model: payload.model ?? "",
      serialNumber: payload.serialNumber ?? "",
      hostname: payload.hostname ?? "",
      ipAddress: payload.ipAddress ?? "",
      assignedTo: payload.assignedTo ?? "",
      location: payload.location ?? "",
      warrantyExpiresAt: toDateInput(payload.warrantyExpiresAt),
      notes: payload.notes ?? "",
    });
  } else if (isKind(record, "vendor")) {
    const payload = record.payload;
    Object.assign(draft, {
      status: payload.status,
      category: payload.category ?? "",
      contactName: payload.contact?.name ?? "",
      contactEmail: payload.contact?.email ?? "",
      contactPhone: payload.contact?.phone ?? "",
      supportUrl: payload.supportUrl ?? "",
      accountNumber: payload.accountNumber ?? "",
      renewalDate: toDateInput(payload.renewalDate),
      noticeDays: payload.noticeDays?.toString() ?? "",
      notes: payload.notes ?? "",
    });
  } else if (isKind(record, "secret")) {
    const payload = record.payload;
    Object.assign(draft, {
      secretType: payload.type,
      username: payload.username ?? "",
      url: payload.url ?? "",
      notes: payload.notes ?? "",
      expiresAt: toDateInput(payload.expiresAt),
    });
  }

  return { draft, steps: [] };
}

function Field({
  label,
  hint,
  wide = false,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={wide ? "form-field form-field-wide" : "form-field"}>
      <span>{label}</span>
      {children}
      {hint ? <small className="form-field-hint">{hint}</small> : null}
    </label>
  );
}

function RecordEditor({
  state,
  busy,
  error,
  dialogRef,
  onClose,
  onSave,
}: {
  state: EditorState;
  busy: boolean;
  error?: string;
  dialogRef: RefObject<HTMLFormElement | null>;
  onClose: () => void;
  onSave: (draft: EditorDraft, steps: RunbookStep[]) => Promise<void>;
}) {
  const initial = useMemo(() => draftForEditor(state), [state]);
  const [draft, setDraft] = useState(initial.draft);
  const [steps, setSteps] = useState(initial.steps);
  const label = KIND_LABEL[state.kind];
  const editing = Boolean(state.record);

  const update = (field: keyof EditorDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const updateStep = (
    index: number,
    field: keyof RunbookStep,
    value: string | boolean,
  ) => {
    setSteps((current) =>
      current.map((step, stepIndex) =>
        stepIndex === index ? { ...step, [field]: value } : step,
      ),
    );
  };

  const addStep = () => {
    setSteps((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        title: "",
        instructions: "",
      },
    ]);
  };

  const removeStep = (index: number) => {
    setSteps((current) => current.filter((_, stepIndex) => stepIndex !== index));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSave(draft, steps);
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className={
          state.kind === "runbook"
            ? "record-dialog record-dialog-wide"
            : "record-dialog"
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-editor-title"
        onSubmit={submit}
      >
        <header className="dialog-header">
          <div>
            <p className="coordinate">
              {editing ? "EDIT RECORD" : "NEW RECORD"}
            </p>
            <h2 id="record-editor-title">
              {editing ? `Edit ${label.toLowerCase()}` : `New ${label.toLowerCase()}`}
            </h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close editor"
            onClick={onClose}
            disabled={busy}
          >
            <X size={17} />
          </button>
        </header>

        <div className="dialog-body">
          {error ? (
            <div className="dialog-error" role="alert">
              <AlertTriangle size={15} />
              {error}
            </div>
          ) : null}

          <div className="form-grid">
            <Field label={`${label} name`}>
              <input
                autoFocus
                value={draft.title}
                onChange={(event) => update("title", event.target.value)}
                required
                disabled={busy}
              />
            </Field>

            <Field
              label="Reference code"
              hint="A short identifier technicians can quote in tickets."
            >
              <input
                value={draft.code}
                onChange={(event) => update("code", event.target.value)}
                placeholder={
                  state.kind === "runbook"
                    ? "SOP-001"
                    : state.kind === "asset"
                      ? "AST-001"
                      : state.kind === "secret"
                        ? "SEC-001"
                        : state.kind === "vendor"
                          ? "VND-001"
                          : "CLT-001"
                }
                required
                disabled={busy}
              />
            </Field>

            {state.kind === "client" ? (
              <>
                <Field label="Status">
                  <select
                    value={draft.status}
                    onChange={(event) => update("status", event.target.value)}
                    disabled={busy}
                  >
                    <option value="active">Active</option>
                    <option value="onboarding">Onboarding</option>
                    <option value="paused">Paused</option>
                    <option value="offboarded">Offboarded</option>
                  </select>
                </Field>
                <Field label="Address">
                  <input
                    value={draft.address}
                    onChange={(event) => update("address", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Primary contact">
                  <input
                    value={draft.contactName}
                    onChange={(event) => update("contactName", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Contact email">
                  <input
                    type="email"
                    value={draft.contactEmail}
                    onChange={(event) => update("contactEmail", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Contact phone">
                  <input
                    value={draft.contactPhone}
                    onChange={(event) => update("contactPhone", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Tags" hint="Comma-separated">
                  <input
                    value={draft.tags}
                    onChange={(event) => update("tags", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Operational notes" wide>
                  <textarea
                    value={draft.notes}
                    onChange={(event) => update("notes", event.target.value)}
                    disabled={busy}
                  />
                </Field>
              </>
            ) : null}

            {state.kind === "runbook" ? (
              <>
                <Field label="Publication status">
                  <select
                    value={draft.status}
                    onChange={(event) => update("status", event.target.value)}
                    disabled={busy}
                  >
                    <option value="published">Published</option>
                    <option value="draft">Draft</option>
                  </select>
                </Field>
                <Field label="Category">
                  <input
                    value={draft.category}
                    onChange={(event) => update("category", event.target.value)}
                    placeholder="Remote access"
                    disabled={busy}
                  />
                </Field>
                <Field label="Estimated minutes">
                  <input
                    type="number"
                    min="0"
                    value={draft.estimatedMinutes}
                    onChange={(event) =>
                      update("estimatedMinutes", event.target.value)
                    }
                    disabled={busy}
                  />
                </Field>
                <Field label="Tags" hint="Comma-separated">
                  <input
                    value={draft.tags}
                    onChange={(event) => update("tags", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Verified on">
                  <input
                    type="date"
                    value={draft.verifiedAt}
                    onChange={(event) => update("verifiedAt", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Review due">
                  <input
                    type="date"
                    value={draft.reviewDueAt}
                    onChange={(event) => update("reviewDueAt", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Purpose and trigger" wide>
                  <textarea
                    value={draft.summary}
                    onChange={(event) => update("summary", event.target.value)}
                    required
                    disabled={busy}
                    placeholder="Explain when a technician should use this runbook."
                  />
                </Field>

                <section className="form-section">
                  <div className="form-section-heading">
                    <div>
                      <strong>Procedure steps</strong>
                      <p className="form-field-hint">
                        Keep each step decisive, testable, and safe to follow under pressure.
                      </p>
                    </div>
                    <button
                      className="secondary-button compact"
                      type="button"
                      onClick={addStep}
                      disabled={busy}
                    >
                      <Plus size={13} />
                      Add step
                    </button>
                  </div>

                  <div className="step-editor-list">
                    {steps.map((step, index) => (
                      <article className="step-editor-card" key={step.id}>
                        <span className="step-editor-index">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <div className="step-editor-fields">
                          <Field label="Step title">
                            <input
                              value={step.title}
                              onChange={(event) =>
                                updateStep(index, "title", event.target.value)
                              }
                              required
                              disabled={busy}
                            />
                          </Field>
                          <Field label="Instructions">
                            <textarea
                              value={step.instructions}
                              onChange={(event) =>
                                updateStep(index, "instructions", event.target.value)
                              }
                              required
                              disabled={busy}
                            />
                          </Field>
                          <Field label="Expected result">
                            <input
                              value={step.expectedResult ?? ""}
                              onChange={(event) =>
                                updateStep(index, "expectedResult", event.target.value)
                              }
                              disabled={busy}
                            />
                          </Field>
                          <Field label="Warning">
                            <input
                              value={step.warning ?? ""}
                              onChange={(event) =>
                                updateStep(index, "warning", event.target.value)
                              }
                              disabled={busy}
                            />
                          </Field>
                        </div>
                        <button
                          className="icon-button danger-button"
                          type="button"
                          aria-label={`Remove step ${index + 1}`}
                          onClick={() => removeStep(index)}
                          disabled={busy}
                        >
                          <Trash2 size={14} />
                        </button>
                      </article>
                    ))}
                  </div>
                </section>
              </>
            ) : null}

            {state.kind === "asset" ? (
              <>
                <Field label="Type">
                  <input
                    value={draft.assetType}
                    onChange={(event) => update("assetType", event.target.value)}
                    required
                    disabled={busy}
                    placeholder="Firewall, server, workstation…"
                  />
                </Field>
                <Field label="Status">
                  <select
                    value={draft.status}
                    onChange={(event) => update("status", event.target.value)}
                    disabled={busy}
                  >
                    <option value="active">Active</option>
                    <option value="spare">Spare</option>
                    <option value="repair">Repair</option>
                    <option value="retired">Retired</option>
                  </select>
                </Field>
                <Field label="Hostname">
                  <input
                    value={draft.hostname}
                    onChange={(event) => update("hostname", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="IP address">
                  <input
                    value={draft.ipAddress}
                    onChange={(event) => update("ipAddress", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Manufacturer">
                  <input
                    value={draft.manufacturer}
                    onChange={(event) => update("manufacturer", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Model">
                  <input
                    value={draft.model}
                    onChange={(event) => update("model", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Serial number">
                  <input
                    value={draft.serialNumber}
                    onChange={(event) => update("serialNumber", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Assigned to">
                  <input
                    value={draft.assignedTo}
                    onChange={(event) => update("assignedTo", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Location">
                  <input
                    value={draft.location}
                    onChange={(event) => update("location", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Warranty expires">
                  <input
                    type="date"
                    value={draft.warrantyExpiresAt}
                    onChange={(event) =>
                      update("warrantyExpiresAt", event.target.value)
                    }
                    disabled={busy}
                  />
                </Field>
                <Field label="Notes" wide>
                  <textarea
                    value={draft.notes}
                    onChange={(event) => update("notes", event.target.value)}
                    disabled={busy}
                  />
                </Field>
              </>
            ) : null}

            {state.kind === "vendor" ? (
              <>
                <Field label="Status">
                  <select
                    value={draft.status}
                    onChange={(event) => update("status", event.target.value)}
                    disabled={busy}
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </Field>
                <Field label="Service category">
                  <input
                    value={draft.category}
                    onChange={(event) => update("category", event.target.value)}
                    placeholder="Connectivity, licensing, support…"
                    disabled={busy}
                  />
                </Field>
                <Field label="Support contact">
                  <input
                    value={draft.contactName}
                    onChange={(event) => update("contactName", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Support email">
                  <input
                    type="email"
                    value={draft.contactEmail}
                    onChange={(event) => update("contactEmail", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Support phone">
                  <input
                    value={draft.contactPhone}
                    onChange={(event) => update("contactPhone", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Support URL">
                  <input
                    type="url"
                    value={draft.supportUrl}
                    onChange={(event) => update("supportUrl", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Account number">
                  <input
                    value={draft.accountNumber}
                    onChange={(event) => update("accountNumber", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Renewal date">
                  <input
                    type="date"
                    value={draft.renewalDate}
                    onChange={(event) => update("renewalDate", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Notice period (days)">
                  <input
                    type="number"
                    min="0"
                    value={draft.noticeDays}
                    onChange={(event) => update("noticeDays", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Contract notes" wide>
                  <textarea
                    value={draft.notes}
                    onChange={(event) => update("notes", event.target.value)}
                    disabled={busy}
                  />
                </Field>
              </>
            ) : null}

            {state.kind === "secret" ? (
              <>
                <Field label="Secret type">
                  <select
                    value={draft.secretType}
                    onChange={(event) => update("secretType", event.target.value)}
                    disabled={busy}
                  >
                    <option value="password">Password</option>
                    <option value="api-key">API key</option>
                    <option value="token">Token</option>
                    <option value="license">License</option>
                    <option value="other">Other</option>
                  </select>
                </Field>
                <Field label="Username or account">
                  <input
                    value={draft.username}
                    onChange={(event) => update("username", event.target.value)}
                    autoComplete="off"
                    disabled={busy}
                  />
                </Field>
                <Field label="Sign-in URL" wide>
                  <input
                    type="url"
                    value={draft.url}
                    onChange={(event) => update("url", event.target.value)}
                    autoComplete="off"
                    disabled={busy}
                  />
                </Field>
                <Field
                  label={editing ? "New secret value" : "Secret value"}
                  hint={
                    editing
                      ? "Leave blank to keep the existing encrypted value."
                      : "Encrypted before it is sent to Appwrite."
                  }
                  wide
                >
                  <textarea
                    value={draft.value}
                    onChange={(event) => update("value", event.target.value)}
                    autoComplete="new-password"
                    spellCheck={false}
                    required={!editing}
                    disabled={busy}
                  />
                </Field>
                <Field
                  label="Vault passphrase"
                  hint="Rivet never stores this passphrase. Your team must retain it separately."
                  wide
                >
                  <input
                    type="password"
                    value={draft.passphrase}
                    onChange={(event) => update("passphrase", event.target.value)}
                    autoComplete="new-password"
                    required={!editing || Boolean(draft.value)}
                    disabled={busy}
                  />
                </Field>
                <Field
                  label="Confirm vault passphrase"
                  hint={
                    editing && !draft.value
                      ? "Only required when rotating the secret value."
                      : "Enter the same passphrase again to prevent an unrecoverable typo."
                  }
                  wide
                >
                  <input
                    type="password"
                    value={draft.passphraseConfirmation}
                    onChange={(event) =>
                      update("passphraseConfirmation", event.target.value)
                    }
                    autoComplete="new-password"
                    required={!editing || Boolean(draft.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Expires">
                  <input
                    type="date"
                    value={draft.expiresAt}
                    onChange={(event) => update("expiresAt", event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="Usage notes" wide>
                  <textarea
                    value={draft.notes}
                    onChange={(event) => update("notes", event.target.value)}
                    disabled={busy}
                  />
                </Field>
              </>
            ) : null}
          </div>
        </div>

        <footer className="dialog-footer">
          <button
            className="secondary-button"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="auth-spin" size={14} /> : <Check size={14} />}
            {busy ? "Saving…" : editing ? "Save changes" : `Create ${label.toLowerCase()}`}
          </button>
        </footer>
      </form>
    </div>
  );
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  if (quoted) throw new Error("The CSV contains an unclosed quoted value.");
  return rows;
}

function assetImportsFromCsv(text: string): {
  rows: AssetImport[];
  errors: string[];
} {
  const parsed = parseCsv(text);
  if (parsed.length < 2) {
    throw new Error("The CSV needs a header row and at least one asset.");
  }

  const headers = parsed[0].map((header) =>
    header.trim().toLowerCase().replace(/[^a-z0-9]/g, ""),
  );
  const indexFor = (...names: string[]) =>
    names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
  const titleIndex = indexFor("name", "title", "assetname");
  const typeIndex = indexFor("type", "assettype");
  if (titleIndex < 0 || typeIndex < 0) {
    throw new Error('CSV headers must include "name" and "type".');
  }

  const codeIndex = indexFor("code", "id", "assetid");
  const statusIndex = indexFor("status");
  const hostnameIndex = indexFor("hostname");
  const ipIndex = indexFor("ip", "ipaddress", "address");
  const serialIndex = indexFor("serial", "serialnumber");
  const assignedIndex = indexFor("assignedto", "owner", "user");
  const locationIndex = indexFor("location", "site");
  const manufacturerIndex = indexFor("manufacturer", "make");
  const modelIndex = indexFor("model");
  const warrantyIndex = indexFor("warranty", "warrantyexpires", "warrantyexpiresat");
  const notesIndex = indexFor("notes", "description");
  const validStatuses = new Set<AssetPayload["status"]>([
    "active",
    "spare",
    "repair",
    "retired",
  ]);
  const result: AssetImport[] = [];
  const errors: string[] = [];

  parsed.slice(1).forEach((row, rowIndex) => {
    const value = (index: number) => (index >= 0 ? row[index]?.trim() ?? "" : "");
    const title = value(titleIndex);
    const type = value(typeIndex);
    if (!title || !type) {
      errors.push(`Row ${rowIndex + 2}: missing name or type.`);
      return;
    }
    const rawStatus = value(statusIndex).toLowerCase();
    const status = validStatuses.has(rawStatus as AssetPayload["status"])
      ? (rawStatus as AssetPayload["status"])
      : "active";
    const code =
      value(codeIndex) ||
      `AST-${Date.now().toString().slice(-6)}-${String(rowIndex + 1).padStart(2, "0")}`;
    const payload: AssetPayload = {
      type,
      status,
      manufacturer: trimOrUndefined(value(manufacturerIndex)),
      model: trimOrUndefined(value(modelIndex)),
      serialNumber: trimOrUndefined(value(serialIndex)),
      hostname: trimOrUndefined(value(hostnameIndex)),
      ipAddress: trimOrUndefined(value(ipIndex)),
      assignedTo: trimOrUndefined(value(assignedIndex)),
      location: trimOrUndefined(value(locationIndex)),
      warrantyExpiresAt: trimOrUndefined(value(warrantyIndex)),
      notes: trimOrUndefined(value(notesIndex)),
    };
    const searchText = [
      title,
      code,
      type,
      payload.hostname,
      payload.ipAddress,
      payload.serialNumber,
      payload.assignedTo,
      payload.location,
      payload.manufacturer,
      payload.model,
      payload.notes,
    ]
      .filter(Boolean)
      .join(" ");
    result.push({ title, code, payload, searchText });
  });

  return { rows: result, errors };
}

function ImportDialog({
  busy,
  error,
  dialogRef,
  onClose,
  onImport,
}: {
  busy: boolean;
  error?: string;
  dialogRef: RefObject<HTMLFormElement | null>;
  onClose: () => void;
  onImport: (rows: AssetImport[]) => Promise<void>;
}) {
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<AssetImport[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [localError, setLocalError] = useState("");

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setLocalError("");
    try {
      const result = assetImportsFromCsv(await file.text());
      setRows(result.rows);
      setParseErrors(result.errors);
    } catch (fileError) {
      setRows([]);
      setParseErrors([]);
      setLocalError(messageFromError(fileError));
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="record-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        onSubmit={(event) => {
          event.preventDefault();
          void onImport(rows);
        }}
      >
        <header className="dialog-header">
          <div>
            <p className="coordinate">BULK ENTRY</p>
            <h2 id="import-title">Import assets from CSV</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close import"
            onClick={onClose}
            disabled={busy}
          >
            <X size={17} />
          </button>
        </header>
        <div className="dialog-body">
          {error || localError ? (
            <div className="dialog-error" role="alert">
              <AlertTriangle size={15} />
              {error || localError}
            </div>
          ) : null}
          <label className="import-zone">
            <Upload aria-hidden="true" />
            <strong>{fileName || "Choose an asset CSV"}</strong>
            <p>
              Required headers: name, type. Optional: code, status, hostname,
              ipAddress, serialNumber, assignedTo, location, manufacturer, model,
              warrantyExpiresAt, notes.
            </p>
            <span className="secondary-button">Select CSV</span>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={chooseFile}
              disabled={busy}
            />
          </label>
          {fileName ? (
            <div className="import-preview" aria-live="polite">
              <strong>
                {rows.length} valid asset{rows.length === 1 ? "" : "s"} ready
              </strong>
              <p>
                {parseErrors.length
                  ? `${parseErrors.length} row${parseErrors.length === 1 ? "" : "s"} will be skipped. ${parseErrors.slice(0, 3).join(" ")}`
                  : "Every parsed row passed validation."}
              </p>
            </div>
          ) : null}
        </div>
        <footer className="dialog-footer">
          <button
            className="secondary-button"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || rows.length === 0}
          >
            {busy ? <LoaderCircle className="auth-spin" size={14} /> : <Upload size={14} />}
            {busy ? "Importing…" : `Import ${rows.length || ""} assets`}
          </button>
        </footer>
      </form>
    </div>
  );
}

function UnlockDialog({
  secret,
  busy,
  error,
  dialogRef,
  onClose,
  onUnlock,
}: {
  secret: StoredRecord<"secret">;
  busy: boolean;
  error?: string;
  dialogRef: RefObject<HTMLFormElement | null>;
  onClose: () => void;
  onUnlock: (passphrase: string) => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onUnlock(passphrase);
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="record-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unlock-title"
        onSubmit={submit}
      >
        <header className="dialog-header">
          <div>
            <p className="coordinate">{secret.sortKey ?? "ENCRYPTED RECORD"}</p>
            <h2 id="unlock-title">Unlock {secret.title}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close unlock prompt"
            onClick={onClose}
            disabled={busy}
          >
            <X size={17} />
          </button>
        </header>
        <div className="dialog-body">
          {error ? (
            <div className="dialog-error" role="alert">
              <AlertTriangle size={15} />
              {error}
            </div>
          ) : null}
          <div className="security-banner">
            <LockKeyhole size={18} />
            <div className="vault-banner-copy">
              <strong>Decryption happens locally</strong>
              <span>
                The passphrase is used in this browser tab and is never saved.
              </span>
            </div>
          </div>
          <div className="form-grid" style={{ marginTop: 16 }}>
            <Field label="Vault passphrase" wide>
              <input
                autoFocus
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                required
                disabled={busy}
              />
            </Field>
          </div>
        </div>
        <footer className="dialog-footer">
          <button
            className="secondary-button"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="auth-spin" size={14} /> : <Eye size={14} />}
            {busy ? "Decrypting…" : "Unlock for 45 seconds"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function InviteDialog({
  team,
  members,
  busy,
  error,
  dialogRef,
  onClose,
  onInvite,
}: {
  team: Models.Team;
  members: Models.Membership[];
  busy: boolean;
  error?: string;
  dialogRef: RefObject<HTMLFormElement | null>;
  onClose: () => void;
  onInvite: (email: string, name: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onInvite(email.trim().toLowerCase(), name.trim());
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="record-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-title"
        onSubmit={submit}
      >
        <header className="dialog-header">
          <div>
            <p className="coordinate">WORKSPACE ACCESS</p>
            <h2 id="invite-title">Invite to {team.name}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close invitation"
            onClick={onClose}
            disabled={busy}
          >
            <X size={17} />
          </button>
        </header>
        <div className="dialog-body">
          {error ? (
            <div className="dialog-error" role="alert">
              <AlertTriangle size={15} />
              {error}
            </div>
          ) : null}
          <div className="form-grid">
            <Field label="Work email">
              <input
                autoFocus
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                disabled={busy}
              />
            </Field>
            <Field label="Name (optional)">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
              />
            </Field>
          </div>
          <div className="invite-members">
            {members.map((member) => (
              <div className="invite-member" key={member.$id}>
                <span>
                  <strong>
                    {member.userName || member.userEmail || member.userId}
                  </strong>
                  <small>
                    {member.userEmail ? `${member.userEmail} · ` : ""}
                    {member.confirm ? "Joined" : "Invitation pending"}
                  </small>
                </span>
                <code>{member.roles.join(", ") || "member"}</code>
              </div>
            ))}
          </div>
        </div>
        <footer className="dialog-footer">
          <button
            className="secondary-button"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="auth-spin" size={14} /> : <UserPlus size={14} />}
            {busy ? "Sending…" : "Send invitation"}
          </button>
        </footer>
      </form>
    </div>
  );
}

export default function Home() {
  const [backendState, setBackendState] = useState<BackendState>("checking");
  const [backendMessage, setBackendMessage] = useState("");
  const [booting, setBooting] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [user, setUser] = useState<Models.User | null>(null);
  const [workspaces, setWorkspaces] = useState<Models.Team[]>([]);
  const [activeTeamId, setActiveTeamId] = useState("");
  const [members, setMembers] = useState<Models.Membership[]>([]);
  const [currentMembership, setCurrentMembership] =
    useState<Models.Membership | null>(null);
  const [records, setRecords] = useState<AnyRecord[]>([]);
  const [dataBusy, setDataBusy] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [dataError, setDataError] = useState("");
  const [view, setView] = useState<View>("Overview");
  const [activeClientId, setActiveClientId] = useState("all");
  const [selectedRunbookId, setSelectedRunbookId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState("Everything");
  const [recordQuery, setRecordQuery] = useState("");
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [layer, setLayer] = useState<LayerState>(null);
  const [layerBusy, setLayerBusy] = useState(false);
  const [layerError, setLayerError] = useState("");
  const [toast, setToast] = useState("");
  const [revealedSecrets, setRevealedSecrets] = useState<
    Record<string, RevealedSecret>
  >({});
  const [clock, setClock] = useState(0);
  const searchRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const recordsRequestRef = useRef(0);
  const membersRequestRef = useRef(0);

  const activeTeam =
    workspaces.find((workspace) => workspace.$id === activeTeamId) ?? null;
  const canInvite = currentMembership?.roles.includes("owner") ?? false;
  const canEdit =
    currentMembership?.roles.some((role) => role === "owner" || role === "editor") ??
    false;
  const canUseVault =
    currentMembership?.roles.some((role) => role === "owner" || role === "vault") ??
    false;

  const clients = useMemo(
    () =>
      records
        .filter((record): record is StoredRecord<"client"> =>
          isKind(record, "client"),
        )
        .sort((a, b) => a.title.localeCompare(b.title)),
    [records],
  );

  const scopedRecords = useMemo(
    () =>
      activeClientId === "all"
        ? records
        : records.filter(
            (record) =>
              record.id === activeClientId || record.clientId === activeClientId,
          ),
    [activeClientId, records],
  );

  const runbooks = useMemo(
    () =>
      scopedRecords
        .filter((record): record is StoredRecord<"runbook"> =>
          isKind(record, "runbook"),
        )
        .sort((a, b) => a.title.localeCompare(b.title)),
    [scopedRecords],
  );
  const assets = useMemo(
    () =>
      scopedRecords
        .filter((record): record is StoredRecord<"asset"> =>
          isKind(record, "asset"),
        )
        .sort((a, b) => a.title.localeCompare(b.title)),
    [scopedRecords],
  );
  const vendors = useMemo(
    () =>
      scopedRecords
        .filter((record): record is StoredRecord<"vendor"> =>
          isKind(record, "vendor"),
        )
        .sort((a, b) => a.title.localeCompare(b.title)),
    [scopedRecords],
  );
  const secrets = useMemo(
    () =>
      scopedRecords
        .filter((record): record is StoredRecord<"secret"> =>
          isKind(record, "secret"),
        )
        .sort((a, b) => a.title.localeCompare(b.title)),
    [scopedRecords],
  );
  const runs = useMemo(
    () =>
      records.filter((record): record is StoredRecord<"run"> =>
        isKind(record, "run"),
      ),
    [records],
  );
  const audits = useMemo(
    () =>
      scopedRecords
        .filter((record): record is StoredRecord<"audit"> =>
          isKind(record, "audit"),
        )
        .sort(
          (a, b) =>
            new Date(b.payload.occurredAt).getTime() -
            new Date(a.payload.occurredAt).getTime(),
        ),
    [scopedRecords],
  );

  const selectedRunbook =
    runbooks.find((runbook) => runbook.id === selectedRunbookId) ?? null;
  const activeRun = selectedRunbook
    ? runs
        .filter(
          (run) =>
            run.payload.runbookId === selectedRunbook.id &&
            run.payload.status === "in-progress",
        )
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )[0] ?? null
    : null;

  const activeClient =
    clients.find((client) => client.id === activeClientId) ?? null;
  const clientTitleFor = (record: AnyRecord) => {
    const clientId = record.kind === "client" ? record.id : record.clientId;
    return clients.find((client) => client.id === clientId)?.title ?? "Unassigned";
  };

  const actor: Actor | null = user
    ? { userId: user.$id, name: user.name, email: user.email }
    : null;

  const verifyBackend = useCallback(async () => {
    setBackendState("checking");
    setBackendMessage("Pinging the Appwrite project…");
    try {
      await client.ping();
      setBackendState("connected");
      setBackendMessage("Appwrite responded successfully.");
      return true;
    } catch (error) {
      setBackendState("failed");
      setBackendMessage(messageFromError(error));
      return false;
    }
  }, []);

  const acceptPendingInvitation = useCallback(async () => {
    const params = new URLSearchParams(window.location.search);
    const teamId = params.get("teamId");
    const membershipId = params.get("membershipId");
    const userId = params.get("userId");
    const secret = params.get("secret");
    if (!teamId || !membershipId || !userId || !secret) return;
    window.history.replaceState({}, "", window.location.pathname);
    await teams.updateMembershipStatus({
      teamId,
      membershipId,
      userId,
      secret,
    });
    setToast("Workspace invitation accepted");
  }, []);

  const loadWorkspaces = useCallback(async () => {
    const result = await teams.list({ total: false });
    setWorkspaces(result.teams);
    const preferred =
      window.localStorage.getItem("rivet.activeTeam") ?? "";
    const next =
      result.teams.find((team) => team.$id === preferred)?.$id ??
      result.teams[0]?.$id ??
      "";
    setActiveTeamId(next);
    return result.teams;
  }, []);

  const restoreSession = useCallback(async () => {
    try {
      await acceptPendingInvitation();
      const current = await account.get();
      setUser(current);
      await loadWorkspaces();
      return current;
    } catch (error) {
      if (
        error instanceof AppwriteException &&
        (error.code === 401 || error.type?.includes("user_unauthorized"))
      ) {
        setUser(null);
        setWorkspaces([]);
        setActiveTeamId("");
        return null;
      }
      throw error;
    }
  }, [acceptPendingInvitation, loadWorkspaces]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await verifyBackend();
      try {
        if (!cancelled) await restoreSession();
      } catch (error) {
        if (!cancelled) setAuthError(messageFromError(error));
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [restoreSession, verifyBackend]);

  const refreshRecords = useCallback(async () => {
    const requestId = ++recordsRequestRef.current;
    if (!activeTeamId) {
      setRecords([]);
      setDataLoaded(true);
      return;
    }
    setDataBusy(true);
    setDataError("");
    try {
      const available = (await listRecords(activeTeamId, {
        includeArchived: false,
      })) as AnyRecord[];
      if (requestId === recordsRequestRef.current) {
        setRecords(available.filter((record) => record.teamId === activeTeamId));
      }
    } catch (error) {
      if (requestId === recordsRequestRef.current) {
        setDataError(messageFromError(error));
      }
    } finally {
      if (requestId === recordsRequestRef.current) {
        setDataBusy(false);
        setDataLoaded(true);
      }
    }
  }, [activeTeamId]);

  const refreshMembers = useCallback(async () => {
    const requestId = ++membersRequestRef.current;
    if (!activeTeamId) {
      setMembers([]);
      setCurrentMembership(null);
      return;
    }
    try {
      const [result, ownMemberships] = await Promise.all([
        teams.listMemberships({
          teamId: activeTeamId,
          total: false,
        }),
        teams.listMemberships({
          teamId: activeTeamId,
          queries: user ? [Query.equal("userId", user.$id)] : [],
          total: false,
        }),
      ]);
      if (requestId === membersRequestRef.current) {
        setMembers(result.memberships);
        const ownMembership =
          ownMemberships.memberships[0] ??
          result.memberships.find(
            (membership) =>
              membership.userId === user?.$id ||
              (Boolean(membership.userEmail) &&
                membership.userEmail.toLowerCase() ===
                  user?.email.toLowerCase()),
          ) ??
          null;
        setCurrentMembership(ownMembership);
        if (!ownMembership) {
          setDataError(
            "Rivet could not resolve your role in this workspace. Refresh or ask an owner to review the membership.",
          );
        }
      }
    } catch (error) {
      if (requestId === membersRequestRef.current) {
        setMembers([]);
        setCurrentMembership(null);
        setDataError(
          `Workspace roles could not be loaded: ${messageFromError(error)}`,
        );
      }
    }
  }, [activeTeamId, user]);

  useEffect(() => {
    if (!user || !activeTeamId) return;
    window.localStorage.setItem("rivet.activeTeam", activeTeamId);
    const timeout = window.setTimeout(() => {
      setActiveClientId("all");
      setSelectedRunbookId(null);
      void Promise.all([refreshRecords(), refreshMembers()]);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [activeTeamId, refreshMembers, refreshRecords, user]);

  useEffect(() => {
    const updateClock = () => setClock(Date.now());
    const initial = window.setTimeout(updateClock, 0);
    const interval = window.setInterval(updateClock, 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const hasRevealed = Object.keys(revealedSecrets).length > 0;
    if (!hasRevealed) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      setClock(now);
      setRevealedSecrets((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([, secret]) => secret.expiresAt > now),
        ),
      );
    }, 1000);
    return () => window.clearInterval(interval);
  }, [revealedSecrets]);

  const closeLayers = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setLayer(null);
    setLayerError("");
    setNewMenuOpen(false);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (layer) return;
        focusReturnRef.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        setMobileNavOpen(false);
        setSearchOpen(true);
        return;
      }
      if (event.key === "Escape") {
        if (layerBusy) return;
        if (mobileNavOpen) {
          setMobileNavOpen(false);
        } else if (searchOpen || layer || newMenuOpen) {
          closeLayers();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    closeLayers,
    layer,
    layerBusy,
    mobileNavOpen,
    newMenuOpen,
    searchOpen,
  ]);

  useEffect(() => {
    const root = searchOpen ? searchRef.current : layer ? dialogRef.current : null;
    if (!root) return;
    const previous =
      focusReturnRef.current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    const focusable = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    window.setTimeout(
      () =>
        (
          root.querySelector<HTMLElement>("[autofocus]") ?? focusable()[0]
        )?.focus(),
      0,
    );
    const trap: EventListener = (event) => {
      if (!(event instanceof KeyboardEvent) || event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", trap);
    return () => {
      root.removeEventListener("keydown", trap);
      window.setTimeout(() => previous?.focus(), 0);
      focusReturnRef.current = null;
    };
  }, [layer, searchOpen]);

  const openLayer = (next: LayerState) => {
    focusReturnRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setLayerError("");
    setSearchOpen(false);
    setLayer(next);
    setNewMenuOpen(false);
    setMobileNavOpen(false);
  };

  const chooseView = (next: View) => {
    setView(next);
    setMobileNavOpen(false);
    setNewMenuOpen(false);
    setRecordQuery("");
  };

  const switchWorkspace = (teamId: string) => {
    recordsRequestRef.current += 1;
    membersRequestRef.current += 1;
    setRecords([]);
    setMembers([]);
    setCurrentMembership(null);
    setRevealedSecrets({});
    setActiveClientId("all");
    setSelectedRunbookId(null);
    setDataError("");
    setDataBusy(true);
    setDataLoaded(false);
    setActiveTeamId(teamId);
  };

  const switchClient = (clientId: string) => {
    setRevealedSecrets({});
    setSelectedRunbookId(null);
    setActiveClientId(clientId);
    setMobileNavOpen(false);
  };

  const signIn = async (email: string, password: string) => {
    setAuthBusy(true);
    setAuthError("");
    try {
      await account.createEmailPasswordSession({ email, password });
      await restoreSession();
    } catch (error) {
      const message = messageFromError(error);
      setAuthError(message);
      throw new Error(message);
    } finally {
      setAuthBusy(false);
    }
  };

  const signUp = async (name: string, email: string, password: string) => {
    setAuthBusy(true);
    setAuthError("");
    try {
      await account.create({
        userId: ID.unique(),
        email,
        password,
        name,
      });
      await account.createEmailPasswordSession({ email, password });
      await restoreSession();
    } catch (error) {
      const message = messageFromError(error);
      setAuthError(message);
      throw new Error(message);
    } finally {
      setAuthBusy(false);
    }
  };

  const signOut = async () => {
    setAuthBusy(true);
    setAuthError("");
    try {
      await account.deleteSession({ sessionId: "current" });
    } catch (error) {
      if (
        !(
          error instanceof AppwriteException &&
          (error.code === 401 || error.type?.includes("user_unauthorized"))
        )
      ) {
        setAuthError(`Sign-out failed: ${messageFromError(error)}`);
        setAuthBusy(false);
        return;
      }
    }
    try {
      await realtime.disconnect();
    } catch {
      // The authenticated session is already gone; realtime cleanup is best effort.
    }
    recordsRequestRef.current += 1;
    membersRequestRef.current += 1;
    setUser(null);
    setWorkspaces([]);
    setActiveTeamId("");
    setRecords([]);
    setMembers([]);
    setCurrentMembership(null);
    setRevealedSecrets({});
    setLayer(null);
    setSearchOpen(false);
    setDataLoaded(false);
    setAuthBusy(false);
  };

  const createWorkspace = async (name: string) => {
    setAuthBusy(true);
    setAuthError("");
    try {
      const workspace = await teams.create({
        teamId: ID.unique(),
        name,
        roles: ["owner", "editor", "vault"],
      });
      setWorkspaces([workspace]);
      setActiveTeamId(workspace.$id);
      setToast(`${workspace.name} is ready`);
    } catch (error) {
      const message = messageFromError(error);
      setAuthError(message);
      throw new Error(message);
    } finally {
      setAuthBusy(false);
    }
  };

  const upsertRecord = (record: AnyRecord) => {
    setRecords((current) => [
      record,
      ...current.filter((item) => item.id !== record.id),
    ]);
  };

  const appendAudit = async (
    action: string,
    target: AnyRecord,
    summary: string,
    data?: AuditPayload["data"],
  ): Promise<boolean> => {
    if (!activeTeamId || !actor) return false;
    const payload: AuditPayload = {
      action,
      occurredAt: new Date().toISOString(),
      actor,
      target: {
        recordId: target.id,
        kind: target.kind,
        title: target.title,
      },
      summary,
      data,
    };
    try {
      const audit = await createAuditRecord({
        teamId: activeTeamId,
        clientId: target.kind === "client" ? target.id : target.clientId,
        title: summary,
        searchText: `${action} ${summary} ${target.title} ${actor.name ?? actor.email ?? ""}`,
        sortKey: payload.occurredAt,
        payload,
      });
      upsertRecord(audit as AnyRecord);
      setClock(new Date(payload.occurredAt).getTime());
      return true;
    } catch (error) {
      setDataError(
        `The change was saved, but its activity entry failed: ${messageFromError(error)}`,
      );
      return false;
    }
  };

  const saveEditor = async (
    state: EditorState,
    draft: EditorDraft,
    steps: RunbookStep[],
  ) => {
    if (!activeTeamId || !user) return;
    if (!canEdit || (state.kind === "secret" && !canUseVault)) {
      setLayerError("Your workspace role does not allow this change.");
      return;
    }
    if (state.kind !== "client" && !activeClient) {
      setLayerError("Select a client before creating this record.");
      return;
    }
    if (!draft.title.trim() || !draft.code.trim()) {
      setLayerError("Name and reference code are required.");
      return;
    }
    setLayerBusy(true);
    setLayerError("");

    try {
      let saved: AnyRecord;
      const common = {
        clientId: state.kind === "client" ? undefined : activeClient?.id,
        title: draft.title.trim(),
        sortKey: draft.code.trim(),
      };

      if (state.kind === "client") {
        const payload: ClientPayload = {
          status: draft.status as ClientPayload["status"],
          address: trimOrUndefined(draft.address),
          primaryContact:
            draft.contactName || draft.contactEmail || draft.contactPhone
              ? {
                  name: trimOrUndefined(draft.contactName),
                  email: trimOrUndefined(draft.contactEmail),
                  phone: trimOrUndefined(draft.contactPhone),
                }
              : undefined,
          notes: trimOrUndefined(draft.notes),
          tags: splitTags(draft.tags),
        };
        const searchText = [
          common.title,
          common.sortKey,
          payload.status,
          payload.address,
          payload.primaryContact?.name,
          payload.primaryContact?.email,
          payload.notes,
          ...(payload.tags ?? []),
        ]
          .filter(Boolean)
          .join(" ");
        saved = state.record
          ? ((await updateRecord<"client">(state.record.id, {
              ...common,
              searchText,
              payload,
            })) as AnyRecord)
          : ((await createRecord({
              teamId: activeTeamId,
              kind: "client",
              ...common,
              searchText,
              payload,
            })) as AnyRecord);
      } else if (state.kind === "runbook") {
        if (!draft.summary.trim()) throw new Error("Add a purpose for this runbook.");
        if (!steps.length) throw new Error("Add at least one procedure step.");
        if (steps.some((step) => !step.title.trim() || !step.instructions.trim())) {
          throw new Error("Every step needs a title and instructions.");
        }
        const previous =
          state.record && isKind(state.record, "runbook")
            ? state.record.payload
            : undefined;
        const payload: RunbookPayload = {
          status: draft.status as RunbookPayload["status"],
          summary: draft.summary.trim(),
          category: trimOrUndefined(draft.category),
          estimatedMinutes: draft.estimatedMinutes
            ? Number(draft.estimatedMinutes)
            : undefined,
          version: previous ? (previous.version ?? 1) + 1 : 1,
          verifiedAt: trimOrUndefined(draft.verifiedAt),
          reviewDueAt: trimOrUndefined(draft.reviewDueAt),
          tags: splitTags(draft.tags),
          steps: steps.map((step) => ({
            ...step,
            title: step.title.trim(),
            instructions: step.instructions.trim(),
            expectedResult: trimOrUndefined(step.expectedResult ?? ""),
            warning: trimOrUndefined(step.warning ?? ""),
          })),
        };
        const searchText = [
          common.title,
          common.sortKey,
          payload.summary,
          payload.category,
          ...(payload.tags ?? []),
          ...payload.steps.flatMap((step) => [
            step.title,
            step.instructions,
            step.expectedResult,
            step.warning,
          ]),
        ]
          .filter(Boolean)
          .join(" ");
        saved = state.record
          ? ((await updateRecord<"runbook">(state.record.id, {
              ...common,
              searchText,
              payload,
            })) as AnyRecord)
          : ((await createRecord({
              teamId: activeTeamId,
              kind: "runbook",
              ...common,
              searchText,
              payload,
            })) as AnyRecord);
      } else if (state.kind === "asset") {
        const payload: AssetPayload = {
          type: draft.assetType.trim(),
          status: draft.status as AssetPayload["status"],
          manufacturer: trimOrUndefined(draft.manufacturer),
          model: trimOrUndefined(draft.model),
          serialNumber: trimOrUndefined(draft.serialNumber),
          hostname: trimOrUndefined(draft.hostname),
          ipAddress: trimOrUndefined(draft.ipAddress),
          assignedTo: trimOrUndefined(draft.assignedTo),
          location: trimOrUndefined(draft.location),
          warrantyExpiresAt: trimOrUndefined(draft.warrantyExpiresAt),
          notes: trimOrUndefined(draft.notes),
        };
        if (!payload.type) throw new Error("Asset type is required.");
        const searchText = [
          common.title,
          common.sortKey,
          payload.type,
          payload.status,
          payload.manufacturer,
          payload.model,
          payload.serialNumber,
          payload.hostname,
          payload.ipAddress,
          payload.assignedTo,
          payload.location,
          payload.notes,
        ]
          .filter(Boolean)
          .join(" ");
        saved = state.record
          ? ((await updateRecord<"asset">(state.record.id, {
              ...common,
              searchText,
              payload,
            })) as AnyRecord)
          : ((await createRecord({
              teamId: activeTeamId,
              kind: "asset",
              ...common,
              searchText,
              payload,
            })) as AnyRecord);
      } else if (state.kind === "vendor") {
        const payload: VendorPayload = {
          status: draft.status as VendorPayload["status"],
          category: trimOrUndefined(draft.category),
          contact:
            draft.contactName || draft.contactEmail || draft.contactPhone
              ? {
                  name: trimOrUndefined(draft.contactName),
                  email: trimOrUndefined(draft.contactEmail),
                  phone: trimOrUndefined(draft.contactPhone),
                }
              : undefined,
          supportUrl: trimOrUndefined(draft.supportUrl),
          accountNumber: trimOrUndefined(draft.accountNumber),
          renewalDate: trimOrUndefined(draft.renewalDate),
          noticeDays: draft.noticeDays ? Number(draft.noticeDays) : undefined,
          notes: trimOrUndefined(draft.notes),
        };
        const searchText = [
          common.title,
          common.sortKey,
          payload.status,
          payload.category,
          payload.contact?.name,
          payload.contact?.email,
          payload.supportUrl,
          payload.accountNumber,
          payload.notes,
        ]
          .filter(Boolean)
          .join(" ");
        saved = state.record
          ? ((await updateRecord<"vendor">(state.record.id, {
              ...common,
              searchText,
              payload,
            })) as AnyRecord)
          : ((await createRecord({
              teamId: activeTeamId,
              kind: "vendor",
              ...common,
              searchText,
              payload,
            })) as AnyRecord);
      } else {
        const previous =
          state.record && isKind(state.record, "secret")
            ? state.record.payload
            : undefined;
        if (draft.value) {
          if (draft.passphrase.length < 12) {
            throw new Error("Use a vault passphrase of at least 12 characters.");
          }
          if (draft.passphrase !== draft.passphraseConfirmation) {
            throw new Error("Vault passphrase confirmation does not match.");
          }
        }
        const encryptedValue = draft.value
          ? await encryptSecretValue(draft.value, draft.passphrase)
          : previous?.value;
        if (!encryptedValue) throw new Error("Secret value is required.");
        const payload: SecretPayload = {
          type: draft.secretType as SecretPayload["type"],
          username: trimOrUndefined(draft.username),
          url: trimOrUndefined(draft.url),
          notes: trimOrUndefined(draft.notes),
          value: encryptedValue,
          lastRotatedAt: draft.value
            ? new Date().toISOString()
            : previous?.lastRotatedAt,
          expiresAt: trimOrUndefined(draft.expiresAt),
        };
        // Deliberately excludes the encrypted or plaintext value.
        const searchText = [
          common.title,
          common.sortKey,
          payload.type,
          payload.username,
          payload.url,
          payload.notes,
        ]
          .filter(Boolean)
          .join(" ");
        saved = state.record
          ? ((await updateRecord<"secret">(state.record.id, {
              ...common,
              searchText,
              payload,
            })) as AnyRecord)
          : ((await createRecord({
              teamId: activeTeamId,
              kind: "secret",
              ...common,
              searchText,
              payload,
            })) as AnyRecord);
      }

      upsertRecord(saved);
      if (saved.kind === "client" && !state.record) switchClient(saved.id);
      if (saved.kind === "runbook") setSelectedRunbookId(saved.id);
      await appendAudit(
        state.record ? `${saved.kind}.updated` : `${saved.kind}.created`,
        saved,
        `${saved.title} ${state.record ? "updated" : "created"}`,
      );
      setLayer(null);
      setToast(`${saved.title} saved`);
    } catch (error) {
      setLayerError(messageFromError(error));
    } finally {
      setLayerBusy(false);
    }
  };

  const archiveStoredRecord = async (record: AnyRecord) => {
    if (!canEdit || (record.kind === "secret" && !canUseVault)) {
      setDataError("Your workspace role does not allow archiving this record.");
      return;
    }
    const linked =
      record.kind === "client"
        ? records.filter((item) => item.clientId === record.id)
        : [];
    const activeRunsToCancel =
      record.kind === "runbook"
        ? runs.filter(
            (run) =>
              run.payload.runbookId === record.id &&
              run.payload.status === "in-progress",
          )
        : [];
    const details = [
      linked.length
        ? `This will also archive ${linked.length} linked record${linked.length === 1 ? "" : "s"}.`
        : "",
      activeRunsToCancel.length
        ? `${activeRunsToCancel.length} active run${activeRunsToCancel.length === 1 ? "" : "s"} will be cancelled.`
        : "",
    ].filter(Boolean);
    const detail = details.length ? ` ${details.join(" ")}` : "";
    if (!window.confirm(`Archive ${record.title}?${detail}`)) return;
    setDataBusy(true);
    setDataError("");
    try {
      const targets = [record, ...linked.filter((item) => item.kind !== "audit")];
      const [archivedTargets, cancelledRuns] = await Promise.all([
        Promise.all(
          targets.map((target) =>
            updateRecord(target.id, {
              archived: true,
            }),
          ),
        ),
        Promise.all(
          activeRunsToCancel.map((run) =>
            updateRecord<"run">(run.id, {
              payload: {
                ...run.payload,
                status: "cancelled",
                completedAt: new Date().toISOString(),
              },
            }),
          ),
        ),
      ]);
      const archivedIds = new Set(archivedTargets.map((target) => target.id));
      const cancelledIds = new Set(cancelledRuns.map((run) => run.id));
      setRecords((current) => [
        ...(cancelledRuns as AnyRecord[]),
        ...current.filter(
          (item) => !archivedIds.has(item.id) && !cancelledIds.has(item.id),
        ),
      ]);
      if (record.kind === "client") switchClient("all");
      if (record.id === selectedRunbookId) setSelectedRunbookId(null);
      await appendAudit(
        `${record.kind}.archived`,
        record,
        `${record.title} archived`,
        linked.length || activeRunsToCancel.length
          ? {
              linkedRecordsArchived: linked.length,
              activeRunsCancelled: activeRunsToCancel.length,
            }
          : undefined,
      );
      setToast(`${record.title} archived`);
    } catch (error) {
      setDataError(messageFromError(error));
    } finally {
      setDataBusy(false);
    }
  };

  const startRun = async (runbook: StoredRecord<"runbook">) => {
    if (!activeTeamId || !actor) return;
    if (!canEdit) {
      setDataError("Your workspace role does not allow running procedures.");
      return;
    }
    if (runbook.payload.status !== "published") {
      setToast("Publish this runbook before starting a run");
      return;
    }
    if (!runbook.payload.steps.length) {
      setDataError("Add at least one step before starting this runbook.");
      return;
    }
    setDataBusy(true);
    setDataError("");
    try {
      const payload: RunPayload = {
        runbookId: runbook.id,
        runbookTitle: runbook.title,
        runbookVersion: runbook.payload.version,
        status: "in-progress",
        startedAt: new Date().toISOString(),
        actor,
        stepResults: runbook.payload.steps.map((step) => ({
          stepId: step.id,
          status: "pending",
        })),
      };
      const run = await createRecord({
        teamId: activeTeamId,
        kind: "run",
        clientId: runbook.clientId,
        title: `Run: ${runbook.title}`,
        searchText: `${runbook.title} ${actor.name ?? actor.email ?? ""} in progress`,
        sortKey: payload.startedAt,
        payload,
      });
      upsertRecord(run as AnyRecord);
      await appendAudit(
        "run.started",
        runbook,
        `${runbook.title} run started`,
        { runId: run.id },
      );
      setToast("Run started — progress will persist");
    } catch (error) {
      setDataError(messageFromError(error));
    } finally {
      setDataBusy(false);
    }
  };

  const toggleRunStep = async (
    runbook: StoredRecord<"runbook">,
    run: StoredRecord<"run">,
    stepId: string,
  ) => {
    if (!canEdit) {
      setDataError("Your workspace role does not allow changing run progress.");
      return;
    }
    const results = run.payload.stepResults.map((result) =>
      result.stepId === stepId
        ? result.status === "completed"
          ? { ...result, status: "pending" as const, completedAt: undefined }
          : {
              ...result,
              status: "completed" as const,
              completedAt: new Date().toISOString(),
            }
        : result,
    );
    const completed = results.every((result) => result.status === "completed");
    const payload: RunPayload = {
      ...run.payload,
      stepResults: results,
      status: completed ? "completed" : "in-progress",
      completedAt: completed ? new Date().toISOString() : undefined,
    };
    setDataBusy(true);
    setDataError("");
    try {
      const updated = await updateRecord<"run">(run.id, {
        payload,
        searchText: `${runbook.title} ${payload.status} ${actor?.name ?? actor?.email ?? ""}`,
      });
      upsertRecord(updated as AnyRecord);
      if (completed) {
        await appendAudit(
          "run.completed",
          runbook,
          `${runbook.title} run completed`,
          { runId: run.id, steps: results.length },
        );
        setToast("Run completed and recorded");
      }
    } catch (error) {
      setDataError(messageFromError(error));
    } finally {
      setDataBusy(false);
    }
  };

  const cancelRun = async (runbook: StoredRecord<"runbook">, run: StoredRecord<"run">) => {
    if (!canEdit) {
      setDataError("Your workspace role does not allow cancelling runs.");
      return;
    }
    if (!window.confirm("Cancel this run? Completed steps will remain in its history.")) return;
    setDataBusy(true);
    try {
      const payload: RunPayload = {
        ...run.payload,
        status: "cancelled",
        completedAt: new Date().toISOString(),
      };
      const updated = await updateRecord<"run">(run.id, { payload });
      upsertRecord(updated as AnyRecord);
      await appendAudit("run.cancelled", runbook, `${runbook.title} run cancelled`, {
        runId: run.id,
      });
      setToast("Run cancelled");
    } catch (error) {
      setDataError(messageFromError(error));
    } finally {
      setDataBusy(false);
    }
  };

  const importAssets = async (rows: AssetImport[]) => {
    if (!activeTeamId || !activeClient) return;
    if (!canEdit) {
      setLayerError("Your workspace role does not allow asset imports.");
      return;
    }
    setLayerBusy(true);
    setLayerError("");
    const created: AnyRecord[] = [];
    const failures: string[] = [];
    for (const row of rows) {
      try {
        const asset = await createRecord({
          teamId: activeTeamId,
          kind: "asset",
          clientId: activeClient.id,
          title: row.title,
          searchText: row.searchText,
          sortKey: row.code,
          payload: row.payload,
        });
        created.push(asset as AnyRecord);
      } catch (error) {
        failures.push(`${row.title}: ${messageFromError(error)}`);
      }
    }
    setRecords((current) => [...created, ...current]);
    if (created[0]) {
      await appendAudit(
        "assets.imported",
        created[0],
        `${created.length} asset${created.length === 1 ? "" : "s"} imported`,
        { imported: created.length, failed: failures.length },
      );
    }
    setLayerBusy(false);
    if (failures.length) {
      setLayer(null);
      setDataError(
        `${created.length} imported; ${failures.length} failed. Re-import only corrected rows. ${failures.slice(0, 3).join(" ")}`,
      );
      setToast(`${created.length} imported; ${failures.length} failed`);
      return;
    }
    setLayer(null);
    setToast(`${created.length} asset${created.length === 1 ? "" : "s"} imported`);
  };

  const unlockSecret = async (
    secret: StoredRecord<"secret">,
    passphrase: string,
  ) => {
    if (!canUseVault) {
      setLayerError("Your workspace role does not include vault access.");
      return;
    }
    setLayerBusy(true);
    setLayerError("");
    try {
      const value = await decryptSecretValue(secret.payload.value, passphrase);
      const auditWritten = await appendAudit(
        "secret.revealed",
        secret as AnyRecord,
        `${secret.title} revealed`,
      );
      if (!auditWritten) {
        throw new Error(
          "The secret was decrypted, but Rivet could not write the required activity entry, so it was not revealed.",
        );
      }
      setRevealedSecrets((current) => ({
        ...current,
        [secret.id]: { value, expiresAt: Date.now() + 45_000 },
      }));
      setLayer(null);
      setToast("Secret unlocked for 45 seconds");
    } catch (error) {
      setLayerError(messageFromError(error));
    } finally {
      setLayerBusy(false);
    }
  };

  const hideSecret = (secretId: string) => {
    setRevealedSecrets((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([recordId]) => recordId !== secretId),
      ),
    );
  };

  const copySecret = async (secret: StoredRecord<"secret">) => {
    if (!canUseVault) {
      setDataError("Your workspace role does not include vault access.");
      return;
    }
    const revealed = revealedSecrets[secret.id];
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.value);
      const auditWritten = await appendAudit(
        "secret.copied",
        secret as AnyRecord,
        `${secret.title} copied`,
      );
      setToast(
        auditWritten
          ? "Secret copied to clipboard"
          : "Secret copied, but its activity entry failed",
      );
    } catch {
      setToast("Clipboard access is unavailable");
    }
  };

  const inviteMember = async (email: string, name: string) => {
    if (!activeTeam) return;
    setLayerBusy(true);
    setLayerError("");
    try {
      await teams.createMembership({
        teamId: activeTeam.$id,
        roles: ["editor", "vault"],
        email,
        name: trimOrUndefined(name),
        url: window.location.origin,
      });
      await refreshMembers();
      setLayer(null);
      setToast(`Invitation sent to ${email}`);
    } catch (error) {
      setLayerError(messageFromError(error));
    } finally {
      setLayerBusy(false);
    }
  };

  const filteredRunbooks = runbooks.filter((record) =>
    `${record.sortKey ?? ""} ${record.title} ${record.searchText ?? ""}`
      .toLowerCase()
      .includes(recordQuery.toLowerCase()),
  );
  const filteredAssets = assets.filter((record) =>
    `${record.sortKey ?? ""} ${record.title} ${record.searchText ?? ""}`
      .toLowerCase()
      .includes(recordQuery.toLowerCase()),
  );
  const filteredVendors = vendors.filter((record) =>
    `${record.sortKey ?? ""} ${record.title} ${record.searchText ?? ""}`
      .toLowerCase()
      .includes(recordQuery.toLowerCase()),
  );
  const filteredSecrets = activeClient
    ? secrets.filter((record) =>
        `${record.sortKey ?? ""} ${record.title} ${record.searchText ?? ""}`
          .toLowerCase()
          .includes(recordQuery.toLowerCase()),
      )
    : [];
  const filteredClients = clients.filter((record) =>
    `${record.sortKey ?? ""} ${record.title} ${record.searchText ?? ""}`
      .toLowerCase()
      .includes(recordQuery.toLowerCase()),
  );

  const searchable = records.filter(
    (record) => record.kind !== "run" && record.kind !== "audit",
  );
  const searchResults = searchable.filter((record) => {
    const scopeKind: Record<string, RecordKind | undefined> = {
      Clients: "client",
      Runbooks: "runbook",
      Assets: "asset",
      Secrets: "secret",
      Vendors: "vendor",
    };
    const matchesScope =
      searchScope === "Everything" || record.kind === scopeKind[searchScope];
    const query = searchQuery.trim().toLowerCase();
    return (
      matchesScope &&
      (!query ||
        `${record.title} ${record.sortKey ?? ""} ${record.searchText ?? ""}`
          .toLowerCase()
          .includes(query))
    );
  });

  const openSearchResult = (record: AnyRecord) => {
    const nextView = KIND_VIEW[record.kind];
    if (record.kind === "client") {
      switchClient(record.id);
    } else if (record.clientId) {
      switchClient(record.clientId);
    }
    if (record.kind === "runbook") setSelectedRunbookId(record.id);
    if (nextView) setView(nextView);
    closeLayers();
  };

  const reviewAttention = runbooks
    .filter((runbook) => {
      if (!runbook.payload.reviewDueAt) return true;
      return (
        new Date(runbook.payload.reviewDueAt).getTime() <
        clock + 30 * 86_400_000
      );
    })
    .map((runbook) => ({
      kind: "Runbook",
      title: runbook.title,
      code: runbook.sortKey ?? "",
      time: runbook.payload.reviewDueAt
        ? relativeTime(runbook.payload.reviewDueAt, clock)
        : "Not verified",
      record: runbook as AnyRecord,
    }));
  const renewalAttention = vendors
    .filter(
      (vendor) =>
        vendor.payload.renewalDate &&
        new Date(vendor.payload.renewalDate).getTime() <
          clock + 45 * 86_400_000,
    )
    .map((vendor) => ({
      kind: "Renewal",
      title: vendor.title,
      code: vendor.sortKey ?? "",
      time: relativeTime(vendor.payload.renewalDate!, clock),
      record: vendor as AnyRecord,
    }));
  const repairAttention = assets
    .filter((asset) => asset.payload.status === "repair")
    .map((asset) => ({
      kind: "Asset",
      title: asset.title,
      code: asset.sortKey ?? "",
      time: "Needs repair",
      record: asset as AnyRecord,
    }));
  const attention = [...reviewAttention, ...renewalAttention, ...repairAttention].slice(
    0,
    8,
  );

  if (booting) {
    return (
      <main className="app-loading">
        <div className="app-loading-card" role="status">
          <LoaderCircle className="auth-spin" />
          <div>
            <strong>Opening Rivet</strong>
            <span>Verifying Appwrite and restoring your session…</span>
          </div>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <AuthGate
        backendState={backendState}
        backendMessage={backendMessage}
        busy={authBusy}
        error={authError}
        onRetryBackend={() => void verifyBackend()}
        onSignIn={signIn}
        onSignUp={signUp}
      />
    );
  }

  if (!workspaces.length) {
    return (
      <WorkspaceSetup
        userName={user.name}
        busy={authBusy}
        error={authError}
        onCreate={createWorkspace}
        onSignOut={() => void signOut()}
      />
    );
  }

  const renderTableToolbar = (count: number, label: string) => (
    <div className="table-toolbar">
      <label>
        <Search size={14} />
        <input
          value={recordQuery}
          onChange={(event) => setRecordQuery(event.target.value)}
          placeholder={`Search ${label.toLowerCase()}…`}
          aria-label={`Search ${label.toLowerCase()}`}
        />
      </label>
      <span>
        {count} {label.toLowerCase()}
      </span>
    </div>
  );

  return (
    <div className="app-shell">
      <aside
        id="workspace-navigation"
        className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`}
        aria-label="Workspace navigation"
      >
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            R
          </span>
          <div>
            <strong>Rivet</strong>
            <span>IT operations vault</span>
          </div>
          <button
            className="icon-button sidebar-close"
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileNavOpen(false)}
          >
            <X size={17} />
          </button>
        </div>

        <div className="workspace-picker">
          <label htmlFor="workspace-select">Workspace</label>
          <select
            id="workspace-select"
            value={activeTeamId}
            onChange={(event) => switchWorkspace(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option value={workspace.$id} key={workspace.$id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </div>

        <button
          className="sidebar-search"
          type="button"
          onClick={() => {
            focusReturnRef.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
            setSearchOpen(true);
          }}
        >
          <Search size={14} />
          <span>Search workspace</span>
          <kbd>⌘ K</kbd>
        </button>

        <nav className="primary-nav" aria-label="Primary">
          <p className="nav-label">Workspace</p>
          {PRIMARY_NAV.map((item) => {
            const Icon = item.icon;
            const count = VIEW_KIND[item.label]
              ? records.filter((record) => record.kind === VIEW_KIND[item.label]).length
              : undefined;
            return (
              <button
                className={view === item.label ? "nav-item active" : "nav-item"}
                type="button"
                key={item.label}
                aria-current={view === item.label ? "page" : undefined}
                onClick={() => chooseView(item.label)}
              >
                <Icon size={15} />
                <span>{item.label}</span>
                {count !== undefined ? <code className="nav-count">{count}</code> : null}
              </button>
            );
          })}
        </nav>

        <div className="client-nav client-nav-scroll">
          <p className="nav-label">Clients</p>
          <button
            className={activeClientId === "all" ? "client-item active" : "client-item"}
            type="button"
            onClick={() => switchClient("all")}
          >
            <span className="client-monogram">
              <Cloud size={13} />
            </span>
            <span>All clients</span>
            <code>{clients.length}</code>
          </button>
          {clients.map((clientRecord) => (
            <button
              className={
                activeClientId === clientRecord.id
                  ? "client-item active"
                  : "client-item"
              }
              type="button"
              key={clientRecord.id}
              onClick={() => switchClient(clientRecord.id)}
            >
              <span className="client-monogram">
                {(clientRecord.sortKey || clientRecord.title)
                  .replace(/[^a-z0-9]/gi, "")
                  .slice(0, 3)
                  .toUpperCase()}
              </span>
              <span>{clientRecord.title}</span>
              <span
                className={`health-indicator health-${clientRecord.payload.status === "active" ? "healthy" : "watch"}`}
              />
            </button>
          ))}
          <button
            className="all-clients"
            type="button"
            onClick={() => chooseView("Clients")}
          >
            Manage clients
            <ChevronRight size={13} />
          </button>
        </div>

        <div className="sidebar-footer">
          <button className="nav-item" type="button" onClick={() => chooseView("Activity")}>
            <Activity size={15} />
            <span>Activity</span>
            <code className="nav-count">{audits.length}</code>
          </button>
          {canInvite ? (
            <button
              className="nav-item"
              type="button"
              onClick={() => openLayer({ type: "invite" })}
            >
              <UserPlus size={15} />
              <span>Invite teammate</span>
            </button>
          ) : null}
          <button className="user-block" type="button" onClick={() => void signOut()}>
            <span className="avatar">{initials(user.name, user.email)}</span>
            <span>
              <strong>{user.name || user.email}</strong>
              <small>Sign out</small>
            </span>
            <LogOut size={13} />
          </button>
        </div>
      </aside>

      {mobileNavOpen ? (
        <button
          className="mobile-scrim"
          type="button"
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}

      <div className="main-shell">
        <header className="command-bar">
          <button
            className="icon-button mobile-menu"
            type="button"
            aria-label="Open navigation"
            aria-controls="workspace-navigation"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu size={18} />
          </button>
          <div className="breadcrumb">
            <span className="mobile-wordmark">RIVET</span>
            <span className="desktop-crumb">{activeTeam?.name}</span>
            <ChevronRight size={14} className="desktop-crumb" />
            <strong>{activeClient?.title ?? "All clients"}</strong>
          </div>
          <button
            className="command-search"
            type="button"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={14} />
            <span>Search runbooks, assets, vendors, and secret metadata</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="command-actions">
            <span
              className={
                backendState === "failed"
                  ? "connection-state connection-state-failed"
                  : "connection-state"
              }
            >
              {backendState === "failed" ? "Appwrite issue" : "Appwrite connected"}
            </span>
            <div className="new-record-wrap">
              <button
                className="primary-button compact"
                type="button"
                onClick={() => setNewMenuOpen((open) => !open)}
              >
                <Plus size={14} />
                New
                <ChevronDown size={12} />
              </button>
              {newMenuOpen ? (
                <div className="new-menu">
                  <p>Create record</p>
                  {(Object.keys(KIND_LABEL) as EditableKind[]).map((kind) => {
                    const Icon = KIND_ICON[kind];
                    return (
                      <button
                        type="button"
                        key={kind}
                        onClick={() => {
                          if (kind !== "client" && !activeClient) {
                            setToast("Select a client first");
                            setNewMenuOpen(false);
                            return;
                          }
                          openLayer({ type: "editor", editor: { kind } });
                        }}
                      >
                        <Icon size={14} />
                        {KIND_LABEL[kind]}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {dataError ? (
          <div className="workspace-error" role="alert">
            <AlertTriangle size={14} />
            <span>{dataError}</span>
            <button type="button" onClick={() => void refreshRecords()}>
              Retry
            </button>
          </div>
        ) : null}

        <main className={`workspace workspace-${view.toLowerCase()}`}>
          {view === "Overview" ? (
            <div className="standard-view">
              <SectionHeader
                eyebrow={`${activeTeam?.name.toUpperCase()} / OPERATIONS`}
                title={activeClient?.title ?? "Workspace overview"}
                description="Live counts, review work, renewal dates, and recent changes from your Appwrite workspace."
                action={
                  <>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void refreshRecords()}
                      disabled={dataBusy}
                    >
                      <RefreshCw
                        className={dataBusy ? "auth-spin" : undefined}
                        size={14}
                      />
                      Refresh
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() =>
                        openLayer({ type: "editor", editor: { kind: "client" } })
                      }
                    >
                      <Plus size={14} />
                      New client
                    </button>
                  </>
                }
              />
              <div className="fact-strip">
                <div>
                  <span>Published runbooks</span>
                  <strong>
                    {runbooks.filter((record) => record.payload.status === "published").length}
                  </strong>
                  <small>{runbooks.length} total</small>
                </div>
                <div>
                  <span>Managed assets</span>
                  <strong>{assets.length}</strong>
                  <small>
                    {assets.filter((record) => record.payload.status === "repair").length} in repair
                  </small>
                </div>
                <div>
                  <span>Encrypted secrets</span>
                  <strong>{secrets.length}</strong>
                  <small>Values excluded from search</small>
                </div>
                <div>
                  <span>Vendor records</span>
                  <strong>{vendors.length}</strong>
                  <small>{renewalAttention.length} renew soon</small>
                </div>
              </div>

              {!dataLoaded || dataBusy ? (
                <div className="app-loading-inline" role="status">
                  <LoaderCircle className="auth-spin" size={18} />
                  Loading this workspace from Appwrite…
                </div>
              ) : !records.length ? (
                <div style={{ marginTop: 24 }}>
                  <EmptyState
                    icon={Database}
                    title="This workspace is ready for real data"
                    description="Create a client, then add runbooks, assets, vendor contracts, and encrypted credentials. Rivet does not seed fictional records."
                    action={
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() =>
                          openLayer({ type: "editor", editor: { kind: "client" } })
                        }
                      >
                        <Plus size={14} />
                        Create first client
                      </button>
                    }
                  />
                </div>
              ) : (
                <div className="overview-grid">
                  <section className="ledger-section attention-section">
                    <div className="ledger-heading">
                      <div>
                        <p className="coordinate">
                          QUEUE / {String(attention.length).padStart(2, "0")}
                        </p>
                        <h2>Needs attention</h2>
                      </div>
                    </div>
                    {attention.length ? (
                      attention.map((item, index) => (
                        <button
                          className="attention-row"
                          type="button"
                          key={`${item.record.id}-${item.kind}`}
                          onClick={() => openSearchResult(item.record)}
                        >
                          <span className={`attention-index attention-${(index % 3) + 1}`}>
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span>
                            <small>
                              {item.kind}
                              {activeClientId === "all"
                                ? ` · ${clientTitleFor(item.record)}`
                                : ""}
                            </small>
                            <strong>{item.title}</strong>
                          </span>
                          <code>{item.code}</code>
                          <span className="attention-time">{item.time}</span>
                          <ChevronRight size={13} />
                        </button>
                      ))
                    ) : (
                      <EmptyState
                        compact
                        icon={CheckCircle2}
                        title="Nothing is overdue"
                        description="Review dates, repair states, and renewals will appear here."
                      />
                    )}
                  </section>

                  <section className="ledger-section">
                    <div className="ledger-heading">
                      <div>
                        <p className="coordinate">RELATIONSHIPS</p>
                        <h2>Environment index</h2>
                      </div>
                    </div>
                    {[
                      ["Clients", clients.length, "client records", "Clients" as View],
                      ["Runbooks", runbooks.length, "procedures", "Runbooks" as View],
                      ["Assets", assets.length, "devices and systems", "Assets" as View],
                      ["Vendors", vendors.length, "contracts and support", "Vendors" as View],
                    ].map(([kind, count, label, nextView]) => (
                      <button
                        className="index-row"
                        type="button"
                        key={kind}
                        onClick={() => chooseView(nextView as View)}
                      >
                        <strong>{kind}</strong>
                        <span>{label}</span>
                        <code>{count}</code>
                        <small>Open ledger</small>
                        <ChevronRight size={13} />
                      </button>
                    ))}
                  </section>

                  <section className="ledger-section recent-section">
                    <div className="ledger-heading">
                      <div>
                        <p className="coordinate">ACTIVITY</p>
                        <h2>Recent changes</h2>
                      </div>
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => chooseView("Activity")}
                      >
                        View all
                      </button>
                    </div>
                    {audits.slice(0, 6).map((audit) => (
                      <div className="activity-row" key={audit.id}>
                        <time>{relativeTime(audit.payload.occurredAt, clock)}</time>
                        <span>
                          <strong>{audit.payload.actor.name || audit.payload.actor.email}</strong>{" "}
                          {audit.payload.summary}
                          {activeClientId === "all" ? (
                            <small> · {clientTitleFor(audit as AnyRecord)}</small>
                          ) : null}
                        </span>
                        <code>{audit.payload.target.kind}</code>
                      </div>
                    ))}
                    {!audits.length ? (
                      <EmptyState
                        compact
                        icon={Activity}
                        title="No activity yet"
                        description="Recorded changes will appear here."
                      />
                    ) : null}
                  </section>
                </div>
              )}
            </div>
          ) : null}

          {view === "Runbooks" ? (
            <div
              className={`runbook-workspace live ${selectedRunbook ? "has-selection" : ""}`}
            >
              <section className="record-list" aria-label="Runbooks">
                <div className="record-list-header">
                  <div>
                    <p className="coordinate">
                      {(activeClient?.sortKey ?? "ALL") + " / KNOWLEDGE"}
                    </p>
                    <h2>Runbooks</h2>
                  </div>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="Create runbook"
                    onClick={() => {
                      if (!activeClient) {
                        setToast("Select a client first");
                        return;
                      }
                      openLayer({ type: "editor", editor: { kind: "runbook" } });
                    }}
                  >
                    <Plus size={16} />
                  </button>
                </div>
                <label className="inline-filter">
                  <Search size={13} />
                  <input
                    value={recordQuery}
                    onChange={(event) => setRecordQuery(event.target.value)}
                    placeholder="Filter runbooks"
                  />
                </label>
                <div className="record-list-body">
                  <p className="list-section-label">
                    {filteredRunbooks.length} procedures
                  </p>
                  {filteredRunbooks.map((runbook) => (
                    <button
                      className={
                        selectedRunbookId === runbook.id
                          ? "record-row active"
                          : "record-row"
                      }
                      type="button"
                      key={runbook.id}
                      onClick={() => setSelectedRunbookId(runbook.id)}
                    >
                      <span className="record-row-top">
                        <code>{runbook.sortKey ?? "SOP"}</code>
                        <StatusPill value={runbook.payload.status} />
                      </span>
                      <span className="record-row-title">{runbook.title}</span>
                      <span className="record-row-meta">
                        <span>
                          {activeClientId === "all"
                            ? clientTitleFor(runbook as AnyRecord)
                            : runbook.payload.category || "General"}
                        </span>
                        <span>{runbook.payload.estimatedMinutes ?? "—"} min</span>
                      </span>
                    </button>
                  ))}
                  {!filteredRunbooks.length ? (
                    <EmptyState
                      compact
                      icon={BookOpen}
                      title={runbooks.length ? "No matching runbooks" : "No runbooks yet"}
                      description={
                        runbooks.length
                          ? "Clear the filter to see every procedure."
                          : "Select a client and document the first repeatable procedure."
                      }
                    />
                  ) : null}
                </div>
                <button
                  className="record-list-footer"
                  type="button"
                  onClick={() => {
                    if (!activeClient) {
                      setToast("Select a client first");
                      return;
                    }
                    openLayer({ type: "editor", editor: { kind: "runbook" } });
                  }}
                >
                  <Plus size={14} />
                  Add runbook
                  <ChevronRight size={13} />
                </button>
              </section>

              {selectedRunbook ? (
                <article className="runbook-reader live">
                  <header className="runbook-header">
                    <button
                      className="mobile-runbook-select"
                      type="button"
                      onClick={() => setSelectedRunbookId(null)}
                    >
                      <ArrowLeft size={14} />
                      All runbooks
                    </button>
                    <div className="runbook-path">
                      <span>{clientTitleFor(selectedRunbook as AnyRecord)}</span>
                      <ChevronRight size={12} />
                      <span>{selectedRunbook.payload.category || "General"}</span>
                    </div>
                    <div className="runbook-title-row">
                      <div>
                        <p className="coordinate">
                          {selectedRunbook.sortKey ?? "RUNBOOK"} / V
                          {selectedRunbook.payload.version ?? 1}
                        </p>
                        <h1>{selectedRunbook.title}</h1>
                      </div>
                      <div className="runbook-actions">
                        {activeRun ? (
                          <>
                            <span className="run-state">
                              <ListChecks size={14} />
                              Run in progress
                            </span>
                            <button
                              className="secondary-button"
                              type="button"
                              onClick={() => void cancelRun(selectedRunbook, activeRun)}
                              disabled={dataBusy}
                            >
                              Cancel run
                            </button>
                          </>
                        ) : (
                          <button
                            className="primary-button"
                            type="button"
                            onClick={() => void startRun(selectedRunbook)}
                            disabled={dataBusy || selectedRunbook.payload.status !== "published"}
                          >
                            <ClipboardList size={14} />
                            Start run
                          </button>
                        )}
                        <button
                          className="secondary-button square-action"
                          type="button"
                          aria-label="Edit runbook"
                          title={
                            activeRun
                              ? "Finish or cancel the active run before editing"
                              : undefined
                          }
                          disabled={Boolean(activeRun)}
                          onClick={() =>
                            openLayer({
                              type: "editor",
                              editor: { kind: "runbook", record: selectedRunbook },
                            })
                          }
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="secondary-button square-action danger-button"
                          type="button"
                          aria-label="Archive runbook"
                          title={
                            activeRun
                              ? "Finish or cancel the active run before archiving"
                              : undefined
                          }
                          disabled={Boolean(activeRun)}
                          onClick={() => void archiveStoredRecord(selectedRunbook)}
                        >
                          <Archive size={14} />
                        </button>
                      </div>
                    </div>
                    <div className="runbook-metadata">
                      <StatusPill
                        value={
                          selectedRunbook.payload.reviewDueAt &&
                          new Date(selectedRunbook.payload.reviewDueAt).getTime() < clock
                            ? "overdue"
                            : selectedRunbook.payload.reviewDueAt
                              ? "verified"
                              : "review due"
                        }
                      />
                      <span className="metadata-rule" />
                      <span>
                        {selectedRunbook.payload.estimatedMinutes ?? "—"} min estimate
                      </span>
                      <span className="metadata-rule" />
                      <span>
                        Review {formatDate(selectedRunbook.payload.reviewDueAt)}
                      </span>
                      {activeRun ? (
                        <div className="run-progress">
                          <strong>
                            {
                              activeRun.payload.stepResults.filter(
                                (result) => result.status === "completed",
                              ).length
                            }
                            /{activeRun.payload.stepResults.length}
                          </strong>
                          <span className="progress-track">
                            <span
                              style={{
                                width: `${
                                  activeRun.payload.stepResults.length
                                    ? (activeRun.payload.stepResults.filter(
                                        (result) => result.status === "completed",
                                      ).length /
                                        activeRun.payload.stepResults.length) *
                                      100
                                    : 0
                                }%`,
                              }}
                            />
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </header>
                  <div className="runbook-content live">
                    <div className="procedure-intro">
                      <p className="coordinate">PURPOSE</p>
                      <p className="runbook-summary">{selectedRunbook.payload.summary}</p>
                    </div>
                    <ol className={activeRun ? "steps running" : "steps"}>
                      {selectedRunbook.payload.steps.map((step, index) => {
                        const result = activeRun?.payload.stepResults.find(
                          (item) => item.stepId === step.id,
                        );
                        const complete = result?.status === "completed";
                        return (
                          <li
                            className={complete ? "step complete" : "step"}
                            key={step.id}
                          >
                            <button
                              className="step-marker"
                              type="button"
                              aria-label={`${complete ? "Mark incomplete" : "Complete"} step ${index + 1}`}
                              disabled={!activeRun || dataBusy}
                              onClick={() =>
                                activeRun
                                  ? void toggleRunStep(
                                      selectedRunbook,
                                      activeRun,
                                      step.id,
                                    )
                                  : undefined
                              }
                            >
                              {complete ? <Check size={14} /> : index + 1}
                            </button>
                            <div className="step-body">
                              <h2>{step.title}</h2>
                              <p>{step.instructions}</p>
                              {step.expectedResult ? (
                                <div className="code-block">
                                  <CheckCircle2 size={14} />
                                  <code>{step.expectedResult}</code>
                                </div>
                              ) : null}
                              {step.warning ? (
                                <div className="warning-note">
                                  <AlertTriangle size={15} />
                                  <span>{step.warning}</span>
                                </div>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                    {!activeRun ? (
                      <p className="run-actions-note">
                        Start a run to persist checklist progress and completion history.
                      </p>
                    ) : null}
                  </div>
                </article>
              ) : (
                <div className="reader-empty">
                  <EmptyState
                    icon={BookOpen}
                    title="Choose a runbook"
                    description="Open a procedure from the ledger to read, edit, or run it."
                  />
                </div>
              )}
            </div>
          ) : null}

          {view === "Assets" ? (
            <div className="standard-view">
              <SectionHeader
                eyebrow={`${activeClient?.sortKey ?? "ALL"} / INVENTORY`}
                title="Assets"
                description="Devices and systems tied to the client context technicians are working in."
                action={
                  <>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => {
                        if (!activeClient) {
                          setToast("Select a client before importing assets");
                          return;
                        }
                        openLayer({ type: "import" });
                      }}
                    >
                      <Upload size={14} />
                      Import CSV
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => {
                        if (!activeClient) {
                          setToast("Select a client first");
                          return;
                        }
                        openLayer({ type: "editor", editor: { kind: "asset" } });
                      }}
                    >
                      <Plus size={14} />
                      New asset
                    </button>
                  </>
                }
              />
              {renderTableToolbar(filteredAssets.length, "Assets")}
              <div className="data-table asset-table live">
                <div className="table-head">
                  <span>Asset</span>
                  <span>Type</span>
                  <span>Address / hostname</span>
                  <span>Assigned</span>
                  <span>Status</span>
                  <span />
                </div>
                {filteredAssets.map((asset) => (
                  <div className="table-row" key={asset.id}>
                    <span className="primary-cell">
                      <span className="asset-symbol">
                        <HardDrive size={14} />
                      </span>
                      <span>
                        <strong>{asset.title}</strong>
                        <code>{asset.sortKey ?? asset.id}</code>
                        {activeClientId === "all" ? (
                          <small>{clientTitleFor(asset as AnyRecord)}</small>
                        ) : null}
                      </span>
                    </span>
                    <span>{asset.payload.type}</span>
                    <code>{asset.payload.hostname || asset.payload.ipAddress || "—"}</code>
                    <span>{asset.payload.assignedTo || asset.payload.location || "—"}</span>
                    <StatusPill value={asset.payload.status} />
                    <span className="table-row-actions">
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`Edit ${asset.title}`}
                        onClick={() =>
                          openLayer({
                            type: "editor",
                            editor: { kind: "asset", record: asset },
                          })
                        }
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        className="icon-button danger-button"
                        type="button"
                        aria-label={`Archive ${asset.title}`}
                        onClick={() => void archiveStoredRecord(asset)}
                      >
                        <Archive size={13} />
                      </button>
                    </span>
                  </div>
                ))}
                {!filteredAssets.length ? (
                  <div className="table-empty-row">
                    {assets.length
                      ? "No assets match this search."
                      : "No asset records for this client context."}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {view === "Secrets" ? (
            <div className="standard-view">
              <SectionHeader
                eyebrow={`${activeClient?.sortKey ?? "ALL"} / VAULT`}
                title="Secrets"
                description="Encrypted credentials with searchable metadata and short-lived local reveal."
                action={
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => {
                      if (!activeClient) {
                        setToast("Select a client first");
                        return;
                      }
                      openLayer({ type: "editor", editor: { kind: "secret" } });
                    }}
                  >
                    <Plus size={14} />
                    New secret
                  </button>
                }
              />
              <div className="security-banner">
                <ShieldCheck size={19} />
                <div className="vault-banner-copy">
                  <strong>Client-side encrypted before storage</strong>
                  <span>
                    AES-GCM ciphertext is stored in Appwrite. Passphrases and plaintext
                    values are excluded from search and persistence.
                  </span>
                </div>
              </div>
              {renderTableToolbar(filteredSecrets.length, "Secrets")}
              {!canUseVault ? (
                <EmptyState
                  icon={ShieldCheck}
                  title="Vault access is required"
                  description="Ask a workspace owner to add the vault role to your membership."
                />
              ) : !activeClient ? (
                <EmptyState
                  icon={LockKeyhole}
                  title="Choose a client before opening the vault"
                  description="Secrets stay hidden in the all-clients view so the tenant context is explicit before reveal."
                />
              ) : (
              <div className="secret-ledger live">
                {filteredSecrets.map((secret) => {
                  const revealed = revealedSecrets[secret.id];
                  const seconds = revealed
                    ? Math.max(0, Math.ceil((revealed.expiresAt - clock) / 1000))
                    : 0;
                  return (
                    <div className="secret-row live" key={secret.id}>
                      <div className="secret-identity">
                        <span className="asset-symbol">
                          <LockKeyhole size={14} />
                        </span>
                        <span>
                          <strong>{secret.title}</strong>
                          <code>{secret.sortKey ?? secret.id}</code>
                        </span>
                      </div>
                      <div>
                        <strong>{secret.payload.username || secret.payload.type}</strong>
                        <small>{secret.payload.url || "No sign-in URL"}</small>
                      </div>
                      <div className="secret-value-preview">
                        <code>{revealed ? revealed.value : "••••••••••••••••"}</code>
                        {revealed ? <small>{seconds}s</small> : null}
                      </div>
                      <div className="secret-actions">
                        {revealed ? (
                          <>
                            <button
                              className="secondary-button"
                              type="button"
                              onClick={() => void copySecret(secret)}
                            >
                              <Copy size={13} />
                              Copy
                            </button>
                            <button
                              className="secondary-button square-action"
                              type="button"
                              aria-label={`Hide ${secret.title}`}
                              onClick={() => hideSecret(secret.id)}
                            >
                              <EyeOff size={13} />
                            </button>
                          </>
                        ) : (
                          <button
                            className="primary-button"
                            type="button"
                            onClick={() => openLayer({ type: "unlock", secret })}
                          >
                            <Eye size={13} />
                            Reveal
                          </button>
                        )}
                        <button
                          className="secondary-button square-action"
                          type="button"
                          aria-label={`Edit or rotate ${secret.title}`}
                          onClick={() =>
                            openLayer({
                              type: "editor",
                              editor: { kind: "secret", record: secret },
                            })
                          }
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="secondary-button square-action danger-button"
                          type="button"
                          aria-label={`Archive ${secret.title}`}
                          onClick={() => void archiveStoredRecord(secret)}
                        >
                          <Archive size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {!filteredSecrets.length ? (
                  <div className="table-empty-row">
                    {secrets.length
                      ? "No secret metadata matches this search."
                      : "No encrypted secrets for this client context."}
                  </div>
                ) : null}
              </div>
              )}
            </div>
          ) : null}

          {view === "Vendors" ? (
            <div className="standard-view">
              <SectionHeader
                eyebrow={`${activeClient?.sortKey ?? "ALL"} / COMMERCIAL`}
                title="Vendors"
                description="Support contacts, account references, contract notes, and renewal windows."
                action={
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => {
                      if (!activeClient) {
                        setToast("Select a client first");
                        return;
                      }
                      openLayer({ type: "editor", editor: { kind: "vendor" } });
                    }}
                  >
                    <Plus size={14} />
                    New vendor
                  </button>
                }
              />
              {renderTableToolbar(filteredVendors.length, "Vendors")}
              <div className="data-table vendor-table live">
                <div className="table-head">
                  <span>Vendor</span>
                  <span>Service</span>
                  <span>Renewal</span>
                  <span>Support</span>
                  <span>Status</span>
                  <span />
                </div>
                {filteredVendors.map((vendor) => (
                  <div className="table-row" key={vendor.id}>
                    <span className="primary-cell">
                      <span className="asset-symbol">
                        <Server size={14} />
                      </span>
                      <span>
                        <strong>{vendor.title}</strong>
                        <code>{vendor.sortKey ?? vendor.id}</code>
                        {activeClientId === "all" ? (
                          <small>{clientTitleFor(vendor as AnyRecord)}</small>
                        ) : null}
                      </span>
                    </span>
                    <span>{vendor.payload.category || "General"}</span>
                    <time>{formatDate(vendor.payload.renewalDate)}</time>
                    <span>
                      {vendor.payload.contact?.email ||
                        vendor.payload.contact?.phone ||
                        "—"}
                    </span>
                    <StatusPill value={vendor.payload.status} />
                    <span className="table-row-actions">
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`Edit ${vendor.title}`}
                        onClick={() =>
                          openLayer({
                            type: "editor",
                            editor: { kind: "vendor", record: vendor },
                          })
                        }
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        className="icon-button danger-button"
                        type="button"
                        aria-label={`Archive ${vendor.title}`}
                        onClick={() => void archiveStoredRecord(vendor)}
                      >
                        <Archive size={13} />
                      </button>
                    </span>
                  </div>
                ))}
                {!filteredVendors.length ? (
                  <div className="table-empty-row">
                    {vendors.length
                      ? "No vendors match this search."
                      : "No vendor or contract records for this client context."}
                  </div>
                ) : null}
              </div>
              {renewalAttention.length ? (
                <div className="renewal-note">
                  <AlertTriangle size={15} />
                  <span>
                    {renewalAttention.length} renewal
                    {renewalAttention.length === 1 ? " is" : "s are"} within 45 days.
                  </span>
                  <button type="button" onClick={() => setRecordQuery("")}>
                    Review ledger
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {view === "Clients" ? (
            <div className="standard-view">
              <SectionHeader
                eyebrow={`${activeTeam?.name.toUpperCase()} / TENANTS`}
                title="Clients"
                description="The tenant boundary for assets, SOPs, vendors, credentials, and operational history."
                action={
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() =>
                      openLayer({ type: "editor", editor: { kind: "client" } })
                    }
                  >
                    <Plus size={14} />
                    New client
                  </button>
                }
              />
              {renderTableToolbar(filteredClients.length, "Clients")}
              <div className="data-table client-table live">
                <div className="table-head">
                  <span>Client</span>
                  <span>Status</span>
                  <span>Primary contact</span>
                  <span>Linked records</span>
                  <span />
                </div>
                {filteredClients.map((clientRecord) => (
                  <div className="table-row" key={clientRecord.id}>
                    <span className="primary-cell">
                      <span className="asset-symbol">
                        <Users size={14} />
                      </span>
                      <span>
                        <strong>{clientRecord.title}</strong>
                        <code>{clientRecord.sortKey ?? clientRecord.id}</code>
                      </span>
                    </span>
                    <StatusPill value={clientRecord.payload.status} />
                    <span>
                      {clientRecord.payload.primaryContact?.name ||
                        clientRecord.payload.primaryContact?.email ||
                        "—"}
                    </span>
                    <code>
                      {records.filter((record) => record.clientId === clientRecord.id).length}
                    </code>
                    <span className="table-row-actions">
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`Open ${clientRecord.title}`}
                        onClick={() => {
                          switchClient(clientRecord.id);
                          setView("Overview");
                        }}
                      >
                        <ChevronRight size={14} />
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`Edit ${clientRecord.title}`}
                        onClick={() =>
                          openLayer({
                            type: "editor",
                            editor: { kind: "client", record: clientRecord },
                          })
                        }
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        className="icon-button danger-button"
                        type="button"
                        aria-label={`Archive ${clientRecord.title}`}
                        onClick={() => void archiveStoredRecord(clientRecord)}
                      >
                        <Archive size={13} />
                      </button>
                    </span>
                  </div>
                ))}
                {!filteredClients.length ? (
                  <div className="table-empty-row">
                    {clients.length
                      ? "No clients match this search."
                      : "Create the first client to start documenting its environment."}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {view === "Activity" ? (
            <div className="standard-view">
              <SectionHeader
                eyebrow={`${activeClient?.sortKey ?? "ALL"} / HISTORY`}
                title="Activity"
                description="Read-only Appwrite rows created as technicians change records, execute runbooks, or reveal credentials."
                action={
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void refreshRecords()}
                    disabled={dataBusy}
                  >
                    <RefreshCw
                      className={dataBusy ? "auth-spin" : undefined}
                      size={14}
                    />
                    Refresh
                  </button>
                }
              />
              <div className="data-table audit-table" style={{ marginTop: 14 }}>
                <div className="table-head">
                  <span>When</span>
                  <span>Event</span>
                  <span>Actor</span>
                  <span>Record</span>
                </div>
                {audits.map((audit) => (
                  <div className="table-row table-row-static" key={audit.id}>
                    <time title={formatDate(audit.payload.occurredAt, true)}>
                      {relativeTime(audit.payload.occurredAt, clock)}
                    </time>
                    <span className="primary-cell">
                      <span className="asset-symbol">
                        <Activity size={14} />
                      </span>
                      <span>
                        <strong>{audit.payload.summary}</strong>
                        <code>{audit.payload.action}</code>
                      </span>
                    </span>
                    <span>
                      {audit.payload.actor.name || audit.payload.actor.email || "Unknown"}
                    </span>
                    <code>
                      {audit.payload.target.kind}:{audit.payload.target.title}
                    </code>
                  </div>
                ))}
                {!audits.length ? (
                  <div className="table-empty-row">
                    No activity has been recorded for this client context.
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </main>

        <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
          {PRIMARY_NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                className={view === item.label ? "active" : ""}
                onClick={() => chooseView(item.label)}
                key={item.label}
              >
                <Icon size={17} />
                {item.label}
              </button>
            );
          })}
        </nav>
      </div>

      {searchOpen ? (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeLayers();
          }}
        >
          <div
            ref={searchRef}
            className="search-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Search workspace"
          >
            <div className="search-input-row">
              <Search size={19} />
              <input
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search by title, code, hostname, person, or note…"
                aria-controls="workspace-search-results"
              />
              <kbd>Esc</kbd>
            </div>
            <div className="search-scope-row">
              <span>{activeTeam?.name}</span>
              {["Everything", "Clients", "Runbooks", "Assets", "Secrets", "Vendors"].map(
                (scope) => (
                  <button
                    className={searchScope === scope ? "active" : ""}
                    type="button"
                    key={scope}
                    onClick={() => setSearchScope(scope)}
                  >
                    {scope}
                  </button>
                ),
              )}
            </div>
            <div className="search-results" id="workspace-search-results">
              <div className="search-results-heading">
                <span>
                  {searchResults.length} result
                  {searchResults.length === 1 ? "" : "s"}
                </span>
                <span>Secret values are never indexed</span>
              </div>
              {searchResults.slice(0, 80).map((record) => {
                const Icon =
                  record.kind === "client"
                    ? Users
                    : record.kind === "runbook"
                      ? BookOpen
                      : record.kind === "asset"
                        ? HardDrive
                        : record.kind === "secret"
                          ? LockKeyhole
                          : Server;
                return (
                  <button
                    className="search-result"
                    type="button"
                    key={record.id}
                    onClick={() => openSearchResult(record)}
                  >
                    <span className="search-result-icon">
                      <Icon size={15} />
                    </span>
                    <span className="search-result-copy">
                      <span>
                        <strong>{record.title}</strong>
                        <em>{record.kind}</em>
                      </span>
                      <small>
                        {clients.find((clientRecord) => clientRecord.id === record.clientId)
                          ?.title ?? activeTeam?.name}
                      </small>
                      <p>{record.searchText || "No additional searchable metadata"}</p>
                    </span>
                    <span className="search-result-meta">
                      {record.sortKey ?? relativeTime(record.updatedAt, clock)}
                    </span>
                    <ChevronRight size={14} />
                  </button>
                );
              })}
              {!searchResults.length ? (
                <div className="search-empty">
                  <Search size={22} />
                  <strong>No matching records</strong>
                  <p>Try a code, hostname, account name, or broader scope.</p>
                </div>
              ) : null}
            </div>
            <div className="search-footer">
              <span>
                <ShieldCheck size={12} />
                Workspace permissions apply to every result
              </span>
              <button type="button" onClick={closeLayers}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {layer?.type === "editor" ? (
        <RecordEditor
          state={layer.editor}
          busy={layerBusy}
          error={layerError}
          dialogRef={dialogRef}
          onClose={() => setLayer(null)}
          onSave={(draft, steps) => saveEditor(layer.editor, draft, steps)}
        />
      ) : null}
      {layer?.type === "import" ? (
        <ImportDialog
          busy={layerBusy}
          error={layerError}
          dialogRef={dialogRef}
          onClose={() => setLayer(null)}
          onImport={importAssets}
        />
      ) : null}
      {layer?.type === "unlock" ? (
        <UnlockDialog
          secret={layer.secret}
          busy={layerBusy}
          error={layerError}
          dialogRef={dialogRef}
          onClose={() => setLayer(null)}
          onUnlock={(passphrase) => unlockSecret(layer.secret, passphrase)}
        />
      ) : null}
      {layer?.type === "invite" && activeTeam ? (
        <InviteDialog
          team={activeTeam}
          members={members}
          busy={layerBusy}
          error={layerError}
          dialogRef={dialogRef}
          onClose={() => setLayer(null)}
          onInvite={inviteMember}
        />
      ) : null}

      <div className={toast ? "toast visible" : "toast"} role="status" aria-live="polite">
        <CheckCircle2 size={15} />
        {toast}
      </div>
    </div>
  );
}

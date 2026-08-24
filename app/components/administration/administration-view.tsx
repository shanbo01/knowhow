"use client";

import {
  Activity,
  BadgeCheck,
  Building2,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileSignature,
  Headphones,
  LoaderCircle,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  UserRoundCog,
  UsersRound,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  knowhowCommand,
  queryAdministration,
  setAdministrationAccess,
} from "../../../lib/knowhow-client";
import type {
  AdministrationAccessMember,
  PlatformAccountRecord,
  PlatformAccountSummary,
  PlatformHealth,
  PlatformHome,
  PlatformNextAction,
  PlatformPage,
  PlatformRole,
  PlatformTicketRecord,
  PlatformTicketSummary,
  Viewer,
} from "../../../lib/knowhow-types";

type AdministrationSection = "overview" | "workspaces" | "support" | "access";

type CommercialAction = {
  kind: "grant_trial" | "extend" | "contract";
  client: PlatformAccountRecord;
};

type AdministrationDialog =
  | { kind: "commercial"; value: CommercialAction }
  | { kind: "relationship"; client: PlatformAccountRecord }
  | { kind: "access"; member?: AdministrationAccessMember }
  | null;

const ACCESS_ROLES: Array<{
  value: PlatformRole;
  label: string;
  description: string;
}> = [
  {
    value: "owner",
    label: "Owner",
    description: "Full administration, including who can access this area.",
  },
  {
    value: "operations",
    label: "Administrator",
    description: "Manage workspaces, trials, contracts, and support.",
  },
  {
    value: "support",
    label: "Support",
    description: "Work the support queue without commercial controls.",
  },
];

const ACCOUNT_TAGS = [
  "employee",
  "investor",
  "partner",
  "beta",
  "press",
  "lifetime",
  "complimentary",
] as const;

function messageFromError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The operation could not be completed.";
}

function formatDate(value?: string | null, withTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" as const } : {}),
  }).format(date);
}

function relativeDate(value?: string | null) {
  if (!value) return "No activity yet";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return formatDate(value);
  const days = Math.round((timestamp - Date.now()) / 86_400_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(days) < 1) return "Today";
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return formatDate(value);
}

function formatBytes(value?: number | null) {
  if (!value) return "0 B";
  if (value < 1_000_000) return `${Math.round(value / 1_000)} KB`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  return `${(value / 1_000_000_000).toFixed(1)} GB`;
}

function titleCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function planLabel(client: PlatformAccountSummary) {
  const plan = client.subscription?.plan ?? "free";
  if (plan === "pro_trial") return "Pro trial";
  return titleCase(plan);
}

function healthLabel(health?: PlatformHealth) {
  if (!health) return "New";
  if (health === "at_risk") return "At risk";
  return titleCase(health);
}

function nextActionLabel(action?: PlatformNextAction) {
  switch (action) {
    case "grant_trial":
      return "Consider a Pro trial";
    case "extend_trial":
      return "Trial extension recommended";
    case "contact_churn":
      return "Reach out before churn";
    case "enterprise_lead":
      return "Enterprise conversation";
    case "offer_seats":
      return "Seat expansion opportunity";
    case "expansion":
      return "Expansion opportunity";
    default:
      return "No action needed";
  }
}

function tomorrowDate(days = 14) {
  const value = new Date(Date.now() + days * 86_400_000);
  return value.toISOString().slice(0, 10);
}

function extensionDate(currentExpiry?: string | null) {
  const current = currentExpiry ? Date.parse(currentExpiry) : 0;
  const baseline = Math.max(Date.now(), Number.isFinite(current) ? current : 0);
  return new Date(baseline + 14 * 86_400_000).toISOString().slice(0, 10);
}

function endOfDayIso(value: string) {
  return new Date(`${value}T23:59:59.000Z`).toISOString();
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = "neutral",
}: {
  icon: typeof Building2;
  label: string;
  value: number;
  detail: string;
  tone?: "neutral" | "attention" | "positive";
}) {
  return (
    <article className="administration-metric" data-tone={tone}>
      <span className="administration-metric-icon">
        <Icon />
      </span>
      <span className="administration-metric-copy">
        <small>{label}</small>
        <strong>{value.toLocaleString()}</strong>
        <span>{detail}</span>
      </span>
    </article>
  );
}

function LoadingState({ label = "Loading live data" }: { label?: string }) {
  return (
    <div className="administration-loading" role="status">
      <LoaderCircle className="spin" />
      <span>{label}…</span>
    </div>
  );
}

function EmptyPanel({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Building2;
  title: string;
  description: string;
}) {
  return (
    <div className="administration-empty">
      <span><Icon /></span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function CommercialDialog({
  value,
  busy,
  onClose,
  onSubmit,
}: {
  value: CommercialAction;
  busy: boolean;
  onClose: () => void;
  onSubmit: (action: string, payload: Record<string, unknown>, success: string) => Promise<void>;
}) {
  const [days, setDays] = useState("14");
  const [expiry, setExpiry] = useState(
    value.kind === "contract"
      ? tomorrowDate(365)
      : extensionDate(value.client.subscription?.expiresAt),
  );
  const [plan, setPlan] = useState<"pro" | "enterprise">("pro");
  const [reference, setReference] = useState("");
  const [complimentary, setComplimentary] = useState(false);
  const [reason, setReason] = useState("");

  const title =
    value.kind === "grant_trial"
      ? "Grant a Pro trial"
      : value.kind === "extend"
        ? "Extend access"
        : "Record a contract";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (value.kind === "grant_trial") {
      await onSubmit(
        "grantProTrial",
        {
          targetWorkspaceId: value.client.id,
          days: Number(days),
          reason,
        },
        "Pro trial granted",
      );
      return;
    }
    if (value.kind === "extend") {
      await onSubmit(
        "extendSubscription",
        {
          targetWorkspaceId: value.client.id,
          expiresAt: endOfDayIso(expiry),
          reason,
          graceDays: 0,
          retentionDays: 90,
        },
        "Access extended",
      );
      return;
    }
    await onSubmit(
      "convertSubscription",
      {
        targetWorkspaceId: value.client.id,
        plan,
        manualReference: reference,
        expiresAt: expiry ? endOfDayIso(expiry) : null,
        complimentary,
        reason,
      },
      "Contract recorded",
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="administration-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {value.client.name} · changes are applied to the live workspace and audited.
          </DialogDescription>
        </DialogHeader>
        <form className="administration-form" onSubmit={(event) => void submit(event)}>
          {value.kind === "grant_trial" ? (
            <label>
              <span>Trial length</span>
              <div className="administration-input-suffix">
                <input
                  type="number"
                  min={1}
                  max={90}
                  required
                  value={days}
                  onChange={(event) => setDays(event.target.value)}
                />
                <small>days</small>
              </div>
            </label>
          ) : null}
          {value.kind === "extend" ? (
            <label>
              <span>New end date</span>
              <input
                type="date"
                min={tomorrowDate(1)}
                required
                value={expiry}
                onChange={(event) => setExpiry(event.target.value)}
              />
              <small>Must be later than the current end date.</small>
            </label>
          ) : null}
          {value.kind === "contract" ? (
            <>
              <div className="administration-form-grid">
                <label>
                  <span>Plan</span>
                  <select value={plan} onChange={(event) => setPlan(event.target.value as typeof plan)}>
                    <option value="pro">Pro</option>
                    <option value="enterprise">Enterprise</option>
                  </select>
                </label>
                <label>
                  <span>Contract end date</span>
                  <input
                    type="date"
                    min={tomorrowDate(1)}
                    required
                    value={expiry}
                    onChange={(event) => setExpiry(event.target.value)}
                  />
                </label>
              </div>
              <label>
                <span>Contract or invoice reference</span>
                <input
                  value={reference}
                  minLength={3}
                  maxLength={128}
                  required
                  placeholder="e.g. Q-2026-014"
                  onChange={(event) => setReference(event.target.value)}
                />
              </label>
              <label className="administration-check-row">
                <input
                  type="checkbox"
                  checked={complimentary}
                  onChange={(event) => setComplimentary(event.target.checked)}
                />
                <span>
                  <strong>Complimentary access</strong>
                  <small>No payment is collected by KnowHow for this contract.</small>
                </span>
              </label>
            </>
          ) : null}
          <label>
            <span>Reason</span>
            <textarea
              minLength={8}
              maxLength={500}
              required
              value={reason}
              placeholder="Why is this change appropriate?"
              onChange={(event) => setReason(event.target.value)}
            />
            <small>This note is stored with the administration audit.</small>
          </label>
          <footer className="administration-dialog-actions">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="spin" /> : <CheckCircle2 />}
              {value.kind === "contract" ? "Record contract" : "Apply change"}
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RelationshipDialog({
  client,
  busy,
  onClose,
  onSubmit,
}: {
  client: PlatformAccountRecord;
  busy: boolean;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [ownerLabel, setOwnerLabel] = useState(client.organization?.ownerLabel ?? "");
  const [notes, setNotes] = useState(client.organization?.internalNotes ?? "");
  const [tags, setTags] = useState<string[]>(client.tags ?? []);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="administration-dialog">
        <DialogHeader>
          <DialogTitle>Update client context</DialogTitle>
          <DialogDescription>
            Keep the relationship owner, internal notes, and important context current.
          </DialogDescription>
        </DialogHeader>
        <form
          className="administration-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit({
              organizationId: client.organizationId,
              ownerLabel,
              internalNotes: notes,
              accountTags: tags,
            });
          }}
        >
          <label>
            <span>Relationship owner</span>
            <input
              value={ownerLabel}
              maxLength={128}
              placeholder="Name or team"
              onChange={(event) => setOwnerLabel(event.target.value)}
            />
          </label>
          <label>
            <span>Internal notes</span>
            <textarea
              value={notes}
              maxLength={4_000}
              placeholder="Context the team should know before the next conversation"
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
          <fieldset className="administration-tag-fieldset">
            <legend>Tags</legend>
            <div>
              {ACCOUNT_TAGS.map((tag) => (
                <label key={tag}>
                  <input
                    type="checkbox"
                    checked={tags.includes(tag)}
                    onChange={(event) =>
                      setTags((current) =>
                        event.target.checked
                          ? [...current, tag]
                          : current.filter((value) => value !== tag),
                      )
                    }
                  />
                  <span>{titleCase(tag)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <footer className="administration-dialog-actions">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="spin" /> : <CheckCircle2 />}
              Save context
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AccessDialog({
  member,
  busy,
  onClose,
  onSubmit,
}: {
  member?: AdministrationAccessMember;
  busy: boolean;
  onClose: () => void;
  onSubmit: (email: string, roles: PlatformRole[]) => Promise<void>;
}) {
  const [email, setEmail] = useState(member?.email ?? "");
  const [roles, setRoles] = useState<PlatformRole[]>(member?.roles ?? ["operations"]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="administration-dialog">
        <DialogHeader>
          <DialogTitle>{member ? "Manage administration access" : "Give account access"}</DialogTitle>
          <DialogDescription>
            The account must already be verified and belong to at least one KnowHow workspace.
          </DialogDescription>
        </DialogHeader>
        <form
          className="administration-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit(email, roles);
          }}
        >
          <label>
            <span>Account email</span>
            <input
              type="email"
              required
              readOnly={Boolean(member)}
              value={email}
              placeholder="person@company.com"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <fieldset className="administration-role-fieldset">
            <legend>Access level</legend>
            <div>
              {ACCESS_ROLES.map((role) => {
                const checked = roles.includes(role.value);
                const lockedOwner = role.value === "owner" && member?.roles.includes("owner");
                return (
                  <label key={role.value} data-selected={checked || undefined}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={lockedOwner}
                      onChange={(event) =>
                        setRoles((current) =>
                          event.target.checked
                            ? [...current, role.value]
                            : current.filter((value) => value !== role.value),
                        )
                      }
                    />
                    <span>
                      <strong>{role.label}</strong>
                      <small>{role.description}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          {member?.roles.includes("owner") ? (
            <p className="administration-form-note">
              Owner access cannot be removed from this screen. This prevents accidental lockout.
            </p>
          ) : null}
          <footer className="administration-dialog-actions">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            {member && !member.roles.includes("owner") ? (
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => void onSubmit(email, [])}
              >
                Revoke access
              </Button>
            ) : null}
            <Button type="submit" disabled={busy || roles.length === 0}>
              {busy ? <LoaderCircle className="spin" /> : <ShieldCheck />}
              Save access
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TicketDialog({
  ticket,
  loading,
  error,
  busy,
  onDismiss,
  onReload,
  onReply,
  onResolve,
}: {
  ticket: PlatformTicketRecord | null;
  loading: boolean;
  error: string;
  busy: boolean;
  onDismiss: () => void;
  onReload: () => Promise<void>;
  onReply: (message: string) => Promise<boolean>;
  onResolve: () => Promise<boolean>;
}) {
  const [reply, setReply] = useState("");
  const [confirmingResolution, setConfirmingResolution] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent className="administration-dialog administration-ticket-dialog">
        <DialogHeader>
          <div className="administration-ticket-heading">
            <span className="administration-ticket-heading-icon"><Headphones /></span>
            <div>
              <DialogTitle>{ticket?.subject ?? "Opening support ticket"}</DialogTitle>
              <DialogDescription>
                {ticket
                  ? `${ticket.workspaceName} · ${ticket.requesterName}`
                  : "Loading the private customer conversation from KnowHow."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {loading && !ticket ? <LoadingState label="Opening ticket" /> : null}

        {!loading && error && !ticket ? (
          <div className="administration-ticket-error" role="alert">
            <CircleAlert />
            <div><strong>Couldn’t open this ticket</strong><p>{error}</p></div>
            <Button type="button" variant="outline" onClick={() => void onReload()}>
              <RefreshCw /> Try again
            </Button>
          </div>
        ) : null}

        {ticket ? (
          <>
            <div className="administration-ticket-toolbar">
              <div className="administration-ticket-status">
                <span data-status={ticket.status}>{titleCase(ticket.status)}</span>
                <small>Updated {relativeDate(ticket.updatedAt)}</small>
              </div>
              {ticket.status === "resolved" ? (
                <span className="administration-ticket-pending"><Clock3 /> Awaiting customer confirmation</span>
              ) : ticket.status === "closed" ? (
                <span className="administration-ticket-closed">
                  <BadgeCheck /> {ticket.closureConfirmedAt ? "Closed by customer" : "Closed before confirmation workflow"}
                </span>
              ) : confirmingResolution ? (
                <div className="administration-ticket-close-confirm" role="group" aria-label="Confirm ticket resolution">
                  <strong>Send to the customer for confirmation?</strong>
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmingResolution(false)}>
                    Keep working
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      if (await onResolve()) setConfirmingResolution(false);
                    }}
                  >
                    {busy ? <LoaderCircle className="spin" /> : <CheckCircle2 />} Mark resolved
                  </Button>
                </div>
              ) : (
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmingResolution(true)}>
                  <CheckCircle2 /> Mark resolved
                </Button>
              )}
            </div>

            <div className="administration-ticket-meta">
              <span><small>Workspace</small><strong>{ticket.workspaceName}</strong></span>
              <span><small>Requester</small><strong>{ticket.requesterName}</strong><em>{ticket.requesterEmail || "No email available"}</em></span>
              <span><small>Opened</small><strong>{formatDate(ticket.createdAt, true)}</strong></span>
              <span>
                <small>{ticket.status === "closed" ? (ticket.closureConfirmedAt ? "Customer confirmed" : "Closed") : ticket.status === "resolved" ? "Marked resolved" : "Response target"}</small>
                <strong>
                  {formatDate(
                    ticket.status === "closed"
                      ? ticket.closureConfirmedAt ?? ticket.closedAt ?? ticket.updatedAt
                      : ticket.status === "resolved"
                        ? ticket.resolvedAt ?? ticket.updatedAt
                        : ticket.responseTargetAt,
                    true,
                  )}
                </strong>
              </span>
            </div>

            <section className="administration-ticket-conversation" aria-label="Ticket conversation">
              <header>
                <div><span>Conversation</span><h3>{ticket.messages.length} {ticket.messages.length === 1 ? "message" : "messages"}</h3></div>
                {loading ? <LoaderCircle className="spin" aria-label="Refreshing conversation" /> : null}
              </header>
              <div className="administration-ticket-messages" aria-live="polite">
                {ticket.messages.map((message) => (
                  <article key={message.id} data-author={message.authorKind}>
                    <header>
                      <div>
                        <strong>{message.authorName}</strong>
                        <span>{message.authorKind === "support" ? "KnowHow Support" : "Customer"}</span>
                      </div>
                      <time dateTime={message.createdAt}>{formatDate(message.createdAt, true)}</time>
                    </header>
                    <p>{message.body}</p>
                  </article>
                ))}
                {!ticket.messages.length ? (
                  <EmptyPanel icon={Headphones} title="No messages found" description="This ticket does not have a visible conversation yet." />
                ) : null}
              </div>
            </section>

            {ticket.status !== "closed" ? (
              <form
                className="administration-ticket-reply"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const message = reply.trim();
                  if (message.length < 2) return;
                  if (await onReply(message)) setReply("");
                }}
              >
                <label>
                  <span>{ticket.status === "resolved" ? `Follow up with ${ticket.requesterName} and reopen` : `Reply to ${ticket.requesterName}`}</span>
                  <textarea
                    required
                    minLength={2}
                    maxLength={4_000}
                    rows={4}
                    value={reply}
                    placeholder="Write a helpful response. Keep credentials and sensitive data out."
                    onChange={(event) => setReply(event.target.value)}
                  />
                </label>
                <div>
                  <small>Email notifications contain no message content.</small>
                  <Button type="submit" disabled={busy || reply.trim().length < 2}>
                    {busy ? <LoaderCircle className="spin" /> : <Send />} Send reply
                  </Button>
                </div>
              </form>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ClientInspector({
  client,
  loading,
  canManage,
  onClose,
  onCommercial,
  onEdit,
}: {
  client: PlatformAccountRecord | null;
  loading: boolean;
  canManage: boolean;
  onClose: () => void;
  onCommercial: (kind: CommercialAction["kind"]) => void;
  onEdit: () => void;
}) {
  if (loading) {
    return <aside className="administration-client-inspector"><LoadingState label="Loading workspace" /></aside>;
  }
  if (!client) {
    return (
      <aside className="administration-client-inspector is-empty">
        <EmptyPanel
          icon={Building2}
          title="Select a workspace"
          description="Open a workspace to see its live usage, activation, contract, trial, and relationship context."
        />
      </aside>
    );
  }

  const canGrantTrial = ["free", "pro_trial"].includes(
    client.subscription?.billedPlan ?? client.subscription?.plan ?? "free",
  );

  return (
    <aside className="administration-client-inspector" aria-label={`${client.name} details`}>
      <header className="administration-inspector-header">
        <div>
          <span className="administration-overline">Workspace record</span>
          <h2>{client.name}</h2>
          <p>{client.organizationName || client.slug}</p>
        </div>
        <Button variant="ghost" size="icon-sm" type="button" aria-label="Close details" onClick={onClose}>
          <X />
        </Button>
      </header>

      <div className="administration-inspector-badges">
        <span className="administration-health" data-health={client.health ?? "free"}>
          {healthLabel(client.health)}
        </span>
        <span>{planLabel(client)}</span>
        {client.complimentary ? <span>Complimentary</span> : null}
      </div>

      <section className="administration-recommendation">
        <span><Sparkles /></span>
        <div>
          <small>Recommended next step</small>
          <strong>{nextActionLabel(client.nextAction)}</strong>
          <p>{client.nextActionReason || "The workspace does not need an immediate commercial action."}</p>
        </div>
      </section>

      {canManage ? (
        <div className="administration-client-actions">
          {canGrantTrial ? (
            <Button type="button" size="sm" onClick={() => onCommercial("grant_trial")}>
              <Sparkles /> Grant trial
            </Button>
          ) : null}
          {client.subscription?.expiresAt ? (
            <Button type="button" size="sm" variant="outline" onClick={() => onCommercial("extend")}>
              <Clock3 /> Extend
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="outline" onClick={() => onCommercial("contract")}>
            <FileSignature /> Contract
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onEdit}>
            <PencilLine /> Context
          </Button>
        </div>
      ) : null}

      <div className="administration-inspector-stats">
        <div><small>Intent</small><strong>{client.intentScore ?? 0}</strong></div>
        <div><small>Members</small><strong>{client.memberCount}</strong></div>
        <div><small>Published</small><strong>{client.publishedCount}</strong></div>
        <div><small>Views</small><strong>{client.usage?.views ?? 0}</strong></div>
      </div>

      <section className="administration-inspector-section">
        <header><h3>Commercial access</h3></header>
        <dl className="administration-definition-list">
          <div><dt>Plan</dt><dd>{planLabel(client)}</dd></div>
          <div><dt>Status</dt><dd>{titleCase(client.subscription?.status ?? client.status)}</dd></div>
          <div><dt>Contract reference</dt><dd>{client.subscription?.manualReference || "Not recorded"}</dd></div>
          <div><dt>Access ends</dt><dd>{formatDate(client.subscription?.expiresAt)}</dd></div>
        </dl>
      </section>

      <section className="administration-inspector-section">
        <header><h3>Activation</h3></header>
        <div className="administration-checklist">
          {(client.activationChecklist ?? []).map((item) => (
            <div key={item.id} data-complete={item.completed || undefined}>
              {item.completed ? <CheckCircle2 /> : <Clock3 />}
              <span><strong>{item.label}</strong><small>{item.completedAt ? formatDate(item.completedAt) : "Not completed"}</small></span>
            </div>
          ))}
          {!client.activationChecklist?.length ? <p>No activation events recorded yet.</p> : null}
        </div>
      </section>

      <section className="administration-inspector-section">
        <header><h3>Usage & limits</h3></header>
        <div className="administration-facts">
          <div><span>Captures</span><strong>{client.usage?.captures ?? 0}</strong></div>
          <div><span>Exports</span><strong>{client.usage?.exportRequests ?? 0}</strong></div>
          <div><span>Creators</span><strong>{client.usage?.creatorCount ?? 0} / {client.usage?.creatorLimit ?? "—"}</strong></div>
          <div><span>Storage</span><strong>{formatBytes(client.usage?.storageBytes)} / {client.usage?.storageLimit ? formatBytes(client.usage.storageLimit) : "—"}</strong></div>
        </div>
      </section>

      <section className="administration-inspector-section">
        <header><h3>Relationship</h3></header>
        <dl className="administration-definition-list">
          <div><dt>Primary contact</dt><dd>{client.organization?.primaryContactName || "—"}</dd></div>
          <div><dt>Email</dt><dd>{client.organization?.primaryContactEmail || "—"}</dd></div>
          <div><dt>Owner</dt><dd>{client.organization?.ownerLabel || "Unassigned"}</dd></div>
          <div><dt>Last activity</dt><dd>{relativeDate(client.lastActivityAt)}</dd></div>
        </dl>
        {client.organization?.internalNotes ? (
          <p className="administration-internal-note">{client.organization.internalNotes}</p>
        ) : null}
      </section>

      <section className="administration-inspector-section">
        <header><h3>Recent timeline</h3></header>
        <div className="administration-timeline">
          {(client.timeline ?? []).slice(0, 8).map((item, index) => (
            <div key={`${item.at}:${item.kind}:${index}`}>
              <span />
              <div><strong>{item.label}</strong><small>{formatDate(item.at, true)}</small></div>
            </div>
          ))}
          {!client.timeline?.length ? <p>No activity has been recorded yet.</p> : null}
        </div>
      </section>
    </aside>
  );
}

export function AdministrationView({ viewer }: { viewer: Viewer }) {
  const roles = viewer.platformRoles ?? [];
  const canManage = roles.some((role) => role === "owner" || role === "operations");
  const canSupport = canManage || roles.includes("support");
  const isOwner = roles.includes("owner");
  const [section, setSection] = useState<AdministrationSection>(
    canManage ? "overview" : "support",
  );
  const [dashboard, setDashboard] = useState<PlatformHome | null>(null);
  const [clients, setClients] = useState<PlatformAccountSummary[]>([]);
  const [clientCursor, setClientCursor] = useState<string | null>(null);
  const [support, setSupport] = useState<PlatformTicketSummary[]>([]);
  const [supportStatus, setSupportStatus] = useState("open");
  const [selectedTicketId, setSelectedTicketId] = useState("");
  const [selectedTicket, setSelectedTicket] = useState<PlatformTicketRecord | null>(null);
  const [ticketLoading, setTicketLoading] = useState(false);
  const [ticketError, setTicketError] = useState("");
  const [accessMembers, setAccessMembers] = useState<AdministrationAccessMember[]>([]);
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedClient, setSelectedClient] = useState<PlatformAccountRecord | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState<"dashboard" | "clients" | "client" | "support" | "access" | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [dialog, setDialog] = useState<AdministrationDialog>(null);

  const loadDashboard = useCallback(async () => {
    if (!canManage) return;
    setLoading("dashboard");
    setError("");
    try {
      const payload = await queryAdministration<PlatformHome>({ resource: "dashboard" });
      setDashboard(payload);
      setLastSyncedAt(new Date().toISOString());
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setLoading("");
    }
  }, [canManage]);

  const loadClients = useCallback(async (cursor?: string, append = false) => {
    if (!canManage) return;
    setLoading("clients");
    setError("");
    try {
      const payload = await queryAdministration<PlatformPage<PlatformAccountSummary>>({
        resource: "clients",
        q: query.trim() || undefined,
        status: status === "all" ? undefined : status,
        cursor,
        limit: "50",
      });
      setClients((current) => (append ? [...current, ...payload.items] : payload.items));
      setClientCursor(payload.nextCursor);
      setLastSyncedAt(new Date().toISOString());
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setLoading("");
    }
  }, [canManage, query, status]);

  const loadClient = useCallback(async (workspaceId: string) => {
    if (!workspaceId || !canManage) return;
    setLoading("client");
    setError("");
    try {
      const payload = await queryAdministration<{ client: PlatformAccountRecord }>({
        resource: "client",
        workspaceId,
      });
      setSelectedClient(payload.client);
    } catch (nextError) {
      setError(messageFromError(nextError));
      setSelectedClient(null);
    } finally {
      setLoading("");
    }
  }, [canManage]);

  const loadSupport = useCallback(async () => {
    if (!canSupport) return;
    setLoading("support");
    setError("");
    try {
      const payload = await queryAdministration<PlatformPage<PlatformTicketSummary>>({
        resource: "support",
        status: supportStatus,
        limit: "50",
      });
      setSupport(payload.items);
      setLastSyncedAt(new Date().toISOString());
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setLoading("");
    }
  }, [canSupport, supportStatus]);

  const loadTicket = useCallback(async (ticketId: string) => {
    if (!ticketId || !canSupport) return;
    setTicketLoading(true);
    setTicketError("");
    try {
      const payload = await queryAdministration<{ ticket: PlatformTicketRecord }>({
        resource: "ticket",
        ticketId,
      });
      setSelectedTicket(payload.ticket);
      setLastSyncedAt(new Date().toISOString());
    } catch (nextError) {
      const message = messageFromError(nextError);
      setTicketError(message);
      setSelectedTicket(null);
    } finally {
      setTicketLoading(false);
    }
  }, [canSupport]);

  const loadAccess = useCallback(async () => {
    if (!isOwner) return;
    setLoading("access");
    setError("");
    try {
      const payload = await queryAdministration<{ members: AdministrationAccessMember[] }>({
        resource: "access",
      });
      setAccessMembers(payload.members);
      setLastSyncedAt(new Date().toISOString());
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setLoading("");
    }
  }, [isOwner]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (section === "overview") void loadDashboard();
      if (section === "support") void loadSupport();
      if (section === "access") void loadAccess();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [section, loadAccess, loadDashboard, loadSupport]);

  useEffect(() => {
    if (section !== "workspaces") return;
    const timeout = window.setTimeout(() => void loadClients(), 250);
    return () => window.clearTimeout(timeout);
  }, [section, loadClients]);

  useEffect(() => {
    if (!selectedClientId) return;
    const timeout = window.setTimeout(
      () => void loadClient(selectedClientId),
      0,
    );
    return () => window.clearTimeout(timeout);
  }, [selectedClientId, loadClient]);

  useEffect(() => {
    if (!selectedTicketId) return;
    const timeout = window.setTimeout(
      () => void loadTicket(selectedTicketId),
      0,
    );
    return () => window.clearTimeout(timeout);
  }, [selectedTicketId, loadTicket]);

  const refresh = useCallback(async () => {
    if (section === "overview") await loadDashboard();
    if (section === "workspaces") {
      await loadClients();
      if (selectedClientId) await loadClient(selectedClientId);
    }
    if (section === "support") {
      await loadSupport();
      if (selectedTicketId) await loadTicket(selectedTicketId);
    }
    if (section === "access") await loadAccess();
  }, [section, loadAccess, loadClient, loadClients, loadDashboard, loadSupport, loadTicket, selectedClientId, selectedTicketId]);

  async function replySupportTicket(message: string) {
    if (!selectedTicketId) return false;
    setBusy(true);
    setTicketError("");
    try {
      await knowhowCommand("replySupportTicket", {
        ticketId: selectedTicketId,
        message,
      });
      toast.success("Reply sent");
      await loadTicket(selectedTicketId);
      void loadSupport();
      if (canManage) void loadDashboard();
      return true;
    } catch (nextError) {
      const nextMessage = messageFromError(nextError);
      setTicketError(nextMessage);
      toast.error(nextMessage);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function resolveSupportTicket() {
    if (!selectedTicketId) return false;
    setBusy(true);
    setTicketError("");
    try {
      await knowhowCommand("resolveSupportTicket", { ticketId: selectedTicketId });
      toast.success("Marked resolved — awaiting customer confirmation");
      await loadTicket(selectedTicketId);
      void loadSupport();
      if (canManage) void loadDashboard();
      return true;
    } catch (nextError) {
      const nextMessage = messageFromError(nextError);
      setTicketError(nextMessage);
      toast.error(nextMessage);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function runCommand(
    action: string,
    payload: Record<string, unknown>,
    success: string,
  ) {
    setBusy(true);
    setError("");
    try {
      await knowhowCommand(action, payload);
      toast.success(success);
      setDialog(null);
      await Promise.all([
        canManage ? loadDashboard() : Promise.resolve(),
        canManage ? loadClients() : Promise.resolve(),
        selectedClientId ? loadClient(selectedClientId) : Promise.resolve(),
      ]);
    } catch (nextError) {
      const message = messageFromError(nextError);
      setError(message);
      toast.error(message);
      throw nextError;
    } finally {
      setBusy(false);
    }
  }

  async function saveAccess(email: string, nextRoles: PlatformRole[]) {
    setBusy(true);
    setError("");
    try {
      await setAdministrationAccess(email, nextRoles);
      toast.success(nextRoles.length ? "Administration access updated" : "Administration access revoked");
      setDialog(null);
      await loadAccess();
    } catch (nextError) {
      const message = messageFromError(nextError);
      setError(message);
      toast.error(message);
      throw nextError;
    } finally {
      setBusy(false);
    }
  }

  const tabs = useMemo(
    () => [
      ...(canManage
        ? [
            { id: "overview" as const, label: "Overview", icon: Activity },
            { id: "workspaces" as const, label: "Workspaces", icon: Building2 },
          ]
        : []),
      ...(canSupport
        ? [{ id: "support" as const, label: "Support", icon: Headphones }]
        : []),
      ...(isOwner
        ? [{ id: "access" as const, label: "Access", icon: ShieldCheck }]
        : []),
    ],
    [canManage, canSupport, isOwner],
  );

  const openClient = (workspaceId: string) => {
    setSection("workspaces");
    setSelectedClientId(workspaceId);
  };
  const openPriorityItem = (
    queueId: string,
    item: { workspaceId: string; href: string },
  ) => {
    if (queueId === "support") {
      const ticketId = new URL(item.href, "https://knowhow.local").searchParams.get("entity");
      if (ticketId) {
        setSelectedTicket(null);
        setTicketError("");
        setSection("support");
        setSelectedTicketId(ticketId);
        return;
      }
    }
    openClient(item.workspaceId);
  };
  const supportComparisonTime = lastSyncedAt ? Date.parse(lastSyncedAt) : 0;

  return (
    <section className="administration-page">
      <header className="administration-page-header">
        <div>
          <span className="administration-overline"><ShieldCheck /> Private administration</span>
          <h1>Run the customer side of KnowHow.</h1>
          <p>
            Live workspace signals, decisions, trials, contracts, support, and access—without a separate app.
          </p>
        </div>
        <div className="administration-sync">
          <span><span className="administration-live-dot" /> Live data</span>
          <small>{lastSyncedAt ? `Synced ${relativeDate(lastSyncedAt)}` : "Not loaded yet"}</small>
          <Button variant="outline" size="sm" type="button" disabled={Boolean(loading)} onClick={() => void refresh()}>
            <RefreshCw className={loading ? "spin" : undefined} /> Refresh
          </Button>
        </div>
      </header>

      <nav className="administration-tabs" aria-label="Administration sections">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              aria-current={section === tab.id ? "page" : undefined}
              onClick={() => setSection(tab.id)}
            >
              <Icon /> {tab.label}
              {tab.id === "support" && dashboard?.counts.openTickets ? (
                <span>{dashboard.counts.openTickets}</span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {error ? (
        <div className="administration-error" role="alert">
          <CircleAlert />
          <span>{error}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setError("")}><X /></button>
        </div>
      ) : null}

      {section === "overview" && canManage ? (
        loading === "dashboard" && !dashboard ? (
          <LoadingState />
        ) : dashboard ? (
          <div className="administration-overview">
            <div className="administration-metrics">
              <MetricCard
                icon={Building2}
                label="Workspaces"
                value={dashboard.counts.customers}
                detail="live customer workspaces"
              />
              <MetricCard
                icon={Clock3}
                label="Active trials"
                value={dashboard.counts.trials}
                detail={`${dashboard.counts.expiringSoon} expiring soon`}
                tone={dashboard.counts.expiringSoon ? "attention" : "neutral"}
              />
              <MetricCard
                icon={Headphones}
                label="Open support"
                value={dashboard.counts.openTickets}
                detail={`${dashboard.counts.overdueSupport} overdue`}
                tone={dashboard.counts.overdueSupport ? "attention" : "neutral"}
              />
              <MetricCard
                icon={Sparkles}
                label="Needs attention"
                value={dashboard.counts.neverActivated + dashboard.counts.failedNotifications}
                detail="activation or delivery issues"
                tone={dashboard.counts.neverActivated + dashboard.counts.failedNotifications ? "attention" : "positive"}
              />
            </div>

            <div className="administration-command-grid">
              <section className="administration-panel administration-priority-panel">
                <header className="administration-panel-header">
                  <div><span>Decision inbox</span><h2>What deserves attention now</h2></div>
                  <small>Ranked from live behavior and lifecycle signals</small>
                </header>
                <div className="administration-priority-list">
                  {dashboard.queues.flatMap((queue) =>
                    queue.items.slice(0, 4).map((item) => (
                      <button type="button" key={`${queue.id}:${item.workspaceId}`} onClick={() => openPriorityItem(queue.id, item)}>
                        <span className="administration-priority-mark"><Sparkles /></span>
                        <span className="administration-priority-copy">
                          <span><strong>{item.name}</strong><small>{queue.title}</small></span>
                          <p>{item.reason}</p>
                        </span>
                        <span className="administration-priority-action">
                          {nextActionLabel(item.nextAction)} <ChevronRight />
                        </span>
                      </button>
                    )),
                  ).slice(0, 10)}
                  {!dashboard.queues.some((queue) => queue.items.length) ? (
                    <EmptyPanel
                      icon={CheckCircle2}
                      title="Nothing urgent"
                      description="No live workspace currently meets an attention rule."
                    />
                  ) : null}
                </div>
              </section>

              <section className="administration-panel administration-activation-panel">
                <header className="administration-panel-header">
                  <div><span>Activation counts</span><h2>How far workspaces have progressed</h2></div>
                </header>
                <div className="administration-funnel">
                  {dashboard.funnel.map((step) => {
                    const maximum = Math.max(...dashboard.funnel.map((item) => item.count), 1);
                    return (
                      <div key={step.id}>
                        <span><strong>{step.label}</strong><small>{step.count}</small></span>
                        <div><i style={{ width: `${Math.max(4, (step.count / maximum) * 100)}%` }} /></div>
                      </div>
                    );
                  })}
                </div>
                <p className="administration-panel-note">
                  These are current milestone counts, not a conversion-rate claim.
                </p>
              </section>
            </div>
          </div>
        ) : (
          <EmptyPanel icon={Activity} title="No administration data yet" description="Live activity will appear as customer workspaces begin using KnowHow." />
        )
      ) : null}

      {section === "workspaces" && canManage ? (
        <div className="administration-workspaces-layout" data-open={Boolean(selectedClientId) || undefined}>
          <section className="administration-panel administration-directory">
            <header className="administration-directory-header">
              <div><span className="administration-overline">Workspace directory</span><h2>Clients & lifecycle</h2></div>
              <div className="administration-directory-controls">
                <label className="administration-search">
                  <Search />
                  <input value={query} placeholder="Search workspace or organization" onChange={(event) => setQuery(event.target.value)} />
                </label>
                <select value={status} aria-label="Filter workspaces" onChange={(event) => setStatus(event.target.value)}>
                  <option value="all">All workspaces</option>
                  <option value="trial">Pro trials</option>
                  <option value="free">Free</option>
                  <option value="pro">Pro</option>
                  <option value="enterprise">Enterprise</option>
                  <option value="at_risk">At risk</option>
                  <option value="high_intent">High intent</option>
                  <option value="win_back">Win-back candidates</option>
                </select>
              </div>
            </header>

            <div className="administration-directory-table" role="table" aria-label="Client workspaces">
              <div className="administration-directory-row is-header" role="row">
                <span>Workspace</span><span>Plan</span><span>Health</span><span>Signal</span><span />
              </div>
              {clients.map((client) => (
                <button
                  className="administration-directory-row"
                  data-selected={selectedClientId === client.id || undefined}
                  type="button"
                  role="row"
                  key={client.id}
                  onClick={() => setSelectedClientId(client.id)}
                >
                  <span className="administration-directory-client">
                    <span>{client.name.slice(0, 1).toUpperCase()}</span>
                    <span><strong>{client.name}</strong><small>{client.organizationName || client.slug} · {client.memberCount ?? 0} members</small></span>
                  </span>
                  <span><strong>{planLabel(client)}</strong><small>{client.subscription?.expiresAt ? `Ends ${formatDate(client.subscription.expiresAt)}` : "No end date"}</small></span>
                  <span><i className="administration-health" data-health={client.health ?? "free"}>{healthLabel(client.health)}</i></span>
                  <span><strong>{nextActionLabel(client.nextAction)}</strong><small>{relativeDate(client.lastActivityAt)}</small></span>
                  <span><ChevronRight /></span>
                </button>
              ))}
              {loading === "clients" && !clients.length ? <LoadingState label="Loading workspaces" /> : null}
              {!loading && !clients.length ? (
                <EmptyPanel icon={Building2} title="No matching workspaces" description="There is no live workspace matching this search and filter." />
              ) : null}
            </div>
            {clientCursor ? (
              <footer className="administration-directory-footer">
                <Button variant="outline" type="button" disabled={loading === "clients"} onClick={() => void loadClients(clientCursor, true)}>
                  {loading === "clients" ? <LoaderCircle className="spin" /> : <Plus />} Load more
                </Button>
              </footer>
            ) : null}
          </section>
          <ClientInspector
            client={selectedClient}
            loading={loading === "client"}
            canManage={canManage}
            onClose={() => {
              setSelectedClientId("");
              setSelectedClient(null);
            }}
            onCommercial={(kind) => selectedClient && setDialog({ kind: "commercial", value: { kind, client: selectedClient } })}
            onEdit={() => selectedClient && setDialog({ kind: "relationship", client: selectedClient })}
          />
        </div>
      ) : null}

      {section === "support" && canSupport ? (
        <section className="administration-panel administration-support">
          <header className="administration-panel-header">
            <div><span>Support operations</span><h2>Customer conversations</h2></div>
            <div className="administration-support-header-actions">
              <small>{support.length} {support.length === 1 ? "ticket" : "tickets"} shown</small>
              <select
                aria-label="Filter support tickets"
                value={supportStatus}
                onChange={(event) => setSupportStatus(event.target.value)}
              >
                <option value="open">Open</option>
                <option value="resolved">Resolved — awaiting customer</option>
                <option value="closed">Closed</option>
                <option value="all">All history</option>
              </select>
            </div>
          </header>
          <div className="administration-support-list">
            {support.map((ticket) => {
              const overdue =
                ticket.status === "waiting_support" &&
                Date.parse(ticket.responseTargetAt) < supportComparisonTime;
              const historical = ticket.status === "resolved" || ticket.status === "closed";
              return (
                <button
                  key={ticket.id}
                  type="button"
                  aria-label={`Open support ticket: ${ticket.subject}`}
                  aria-haspopup="dialog"
                  onClick={() => {
                    setSelectedTicket(null);
                    setTicketError("");
                    setSelectedTicketId(ticket.id);
                  }}
                >
                  <span className="administration-support-icon"><Headphones /></span>
                  <span className="administration-support-copy">
                    <span><strong>{ticket.subject}</strong><i data-status={ticket.status}>{titleCase(ticket.status)}</i></span>
                    <p>{ticket.workspaceName} · {ticket.requesterName}</p>
                  </span>
                  <span className="administration-support-target" data-overdue={overdue || undefined}>
                    <small>{overdue ? "Response overdue" : historical ? titleCase(ticket.status) : "Response target"}</small>
                    <strong>{formatDate(historical ? ticket.updatedAt : ticket.responseTargetAt, true)}</strong>
                    <span className="administration-support-open">Updated {relativeDate(ticket.updatedAt)} <ChevronRight /></span>
                  </span>
                </button>
              );
            })}
            {loading === "support" && !support.length ? <LoadingState label="Loading support" /> : null}
            {!loading && !support.length ? (
              <EmptyPanel
                icon={BadgeCheck}
                title={supportStatus === "open" ? "Support queue is clear" : `No ${supportStatus} tickets`}
                description={supportStatus === "open" ? "No open live support tickets need a response." : "No live tickets match this history filter."}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {section === "access" && isOwner ? (
        <section className="administration-panel administration-access">
          <header className="administration-access-header">
            <div><span className="administration-overline">Owner control</span><h2>Who can open KnowHow Administration</h2><p>Access is tied to verified KnowHow accounts and enforced again by the server.</p></div>
            <Button type="button" onClick={() => setDialog({ kind: "access" })}><Plus /> Give account access</Button>
          </header>
          <div className="administration-access-list">
            {accessMembers.map((member) => (
              <article key={member.userId}>
                <span className="administration-access-avatar">{(member.name || member.email).slice(0, 1).toUpperCase()}</span>
                <span className="administration-access-person"><strong>{member.name}</strong><small>{member.email}</small></span>
                <span className="administration-access-roles">
                  {member.roles.map((role) => <i key={role}>{role === "operations" ? "Administrator" : titleCase(role)}</i>)}
                </span>
                <span className="administration-access-state">
                  {member.emailVerified && member.enabled ? <><BadgeCheck /> Verified</> : <><CircleAlert /> Unavailable</>}
                  <small>{member.lastActiveAt ? `Active ${relativeDate(member.lastActiveAt)}` : "No activity recorded"}</small>
                </span>
                <Button variant="outline" size="sm" type="button" onClick={() => setDialog({ kind: "access", member })}>
                  <UserRoundCog /> Manage
                </Button>
              </article>
            ))}
            {loading === "access" && !accessMembers.length ? <LoadingState label="Loading access" /> : null}
            {!loading && !accessMembers.length ? (
              <EmptyPanel icon={UsersRound} title="No access records" description="The active owner account will appear after the live role record is available." />
            ) : null}
          </div>
        </section>
      ) : null}

      {dialog?.kind === "commercial" ? (
        <CommercialDialog
          key={`${dialog.value.client.id}:${dialog.value.kind}`}
          value={dialog.value}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={runCommand}
        />
      ) : null}
      {dialog?.kind === "relationship" ? (
        <RelationshipDialog
          key={dialog.client.id}
          client={dialog.client}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(payload) => runCommand("updateOrganizationRecord", payload, "Client context updated")}
        />
      ) : null}
      {dialog?.kind === "access" ? (
        <AccessDialog
          key={dialog.member?.userId ?? "new"}
          member={dialog.member}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={saveAccess}
        />
      ) : null}
      {selectedTicketId && section === "support" ? (
        <TicketDialog
          key={selectedTicketId}
          ticket={selectedTicket}
          loading={ticketLoading}
          error={ticketError}
          busy={busy}
          onDismiss={() => {
            setSelectedTicketId("");
            setSelectedTicket(null);
            setTicketError("");
          }}
          onReload={() => loadTicket(selectedTicketId)}
          onReply={replySupportTicket}
          onResolve={resolveSupportTicket}
        />
      ) : null}
    </section>
  );
}

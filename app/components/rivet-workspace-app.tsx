"use client";

import {
  Activity,
  Archive,
  ArrowRight,
  BarChart3,
  BookOpen,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  ClipboardCheck,
  Copy,
  Download,
  Eye,
  FileDown,
  FileText,
  Filter,
  Globe2,
  Group,
  History,
  ImagePlus,
  KeyRound,
  Laptop,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Mail,
  Menu,
  Moon,
  MoreHorizontal,
  Paintbrush,
  Pause,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  UserCheck,
  UserCog,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import {
  useEffect,
  useCallback,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  downloadAuditCsv,
  downloadAuthorizedExport,
  removeWorkspaceLogo,
  rivetCommand,
  uploadWorkspaceLogo,
} from "../../lib/rivet-client";
import { decryptSecretValue, encryptSecretValue } from "../../lib/crypto";
import type { EncryptedSecretEnvelope } from "../../lib/domain";
import type {
  AuditEvent,
  BootstrapResponse,
  Guide,
  Invitation,
  PlatformWorkspace,
  VaultItem,
  WorkspaceGroup,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceSettings,
} from "../../lib/rivet-types";
import { WORKSPACE_ROLES } from "../../lib/rivet-types";
import { useTheme } from "./theme-provider";
import { GuideEditor, ScreenshotAnnotationPreview, type GuideEditorPayload } from "./guide-editor";
import { AuthorizedMedia } from "./authorized-media";

type View =
  | "Overview"
  | "Guides"
  | "Capture"
  | "Groups"
  | "Members"
  | "Vault"
  | "Activity"
  | "Settings"
  | "Platform";

type DialogState =
  | null
  | { type: "guide-editor"; guide: Guide | null }
  | { type: "group"; group: WorkspaceGroup | null }
  | { type: "invite" }
  | { type: "member"; member: WorkspaceMember }
  | { type: "guide"; guide: Guide; initialRevision?: "working" | "published" }
  | { type: "extension" }
  | { type: "platform-create" }
  | { type: "assign-admin"; workspace: PlatformWorkspace }
  | { type: "vault-editor"; item: VaultItem | null }
  | { type: "vault-reveal"; item: VaultItem };

const NAV_ITEMS: Array<{ view: View; icon: typeof LayoutDashboard }> = [
  { view: "Overview", icon: LayoutDashboard },
  { view: "Guides", icon: BookOpen },
  { view: "Capture", icon: Sparkles },
  { view: "Groups", icon: Group },
  { view: "Members", icon: Users },
  { view: "Vault", icon: KeyRound },
  { view: "Activity", icon: Activity },
  { view: "Settings", icon: Settings },
];

const ROLE_COPY: Record<WorkspaceRole, string> = {
  administrator: "Workspace settings, people, permissions, and all guides",
  creator: "Create and edit their own draft guides",
  reviewer: "Inspect private drafts and record reviews",
  publisher: "Publish reviewed revisions and archive guides",
  viewer: "Read published guides shared with their audiences",
};

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : "The operation could not be completed.";
}

function formatDate(value?: string, withTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" as const } : {}),
  }).format(date);
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function initials(name: string, email = "") {
  const source = name.trim() || email;
  return source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function titleCase(value: string) {
  return value.replace(/[-_.]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-${status.toLowerCase()}`}>{titleCase(status)}</span>;
}

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof BookOpen;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon /></span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

function Modal({
  title,
  eyebrow,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal-card${wide ? " modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header className="modal-header">
          <div>
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            <h2 id="modal-title">{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close"><X /></button>
        </header>
        {children}
      </section>
    </div>
  );
}

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint: string;
  icon: typeof Users;
  tone?: "default" | "accent" | "warning";
}) {
  return (
    <article className={`metric-card metric-${tone}`}>
      <div className="metric-top"><span>{label}</span><Icon /></div>
      <strong>{value}</strong>
      <small>{hint}</small>
    </article>
  );
}

function OverviewView({
  data,
  canCreate,
  canCapture,
  onNewGuide,
  onOpenGuide,
  onNavigate,
}: {
  data: NonNullable<BootstrapResponse["activeWorkspace"]>;
  canCreate: boolean;
  canCapture: boolean;
  onNewGuide: () => void;
  onOpenGuide: (guide: Guide) => void;
  onNavigate: (view: View) => void;
}) {
  const { metrics, guides, groups, members } = data;
  const recent = [...guides].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);

  return (
    <div className="view-stack">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Governed knowledge</p>
          <h1>Make the next correct action obvious.</h1>
          <p>Capture privately, review deliberately, then publish each revision to exactly the people who need it.</p>
          <div className="hero-actions">
            <button className="button primary" type="button" disabled={!canCreate} onClick={onNewGuide}><Plus /> Create guide</button>
            <button className="button secondary" type="button" disabled={!canCapture} onClick={() => onNavigate("Capture")}><Sparkles /> Capture a workflow</button>
          </div>
        </div>
        <div className="governance-flow" aria-label="Guide lifecycle">
          <span><FileText /> Draft</span><ArrowRight /><span><ClipboardCheck /> Review</span><ArrowRight /><span className="active"><Globe2 /> Published</span>
        </div>
      </section>

      <section className="metric-grid">
        <MetricCard label="Published" value={metrics.published} hint="Available to assigned audiences" icon={Globe2} tone="accent" />
        <MetricCard label="Private drafts" value={metrics.drafts} hint={`${metrics.reviews} awaiting review`} icon={FileText} />
        <MetricCard label="Members" value={metrics.members} hint={`${groups.length} audience groups`} icon={Users} />
        <MetricCard label="Usage" value={metrics.views + metrics.completions} hint={`${metrics.completions} completed guides`} icon={BarChart3} />
      </section>

      <div className="overview-grid">
        <section className="card table-card">
          <div className="section-heading">
            <div><p className="eyebrow">Recently changed</p><h2>Guides</h2></div>
            <button className="button ghost small" type="button" onClick={() => onNavigate("Guides")}>View all <ArrowRight /></button>
          </div>
          {recent.length ? (
            <div className="guide-list compact-list">
              {recent.map((guide) => {
                const revision = guide.workingRevision ?? guide.publishedRevision;
                return (
                  <button className="guide-row" type="button" key={guide.id} onClick={() => onOpenGuide(guide)}>
                    <span className="guide-icon"><BookOpen /></span>
                    <span className="guide-row-main"><strong>{revision?.title ?? guide.title}</strong><small>{revision?.category || "Uncategorized"} · Updated {formatDate(guide.updatedAt)}</small></span>
                    <StatusBadge status={guide.status} />
                    {guide.restricted ? <LockKeyhole className="restricted-icon" aria-label="Restricted" /> : null}
                    <ArrowRight />
                  </button>
                );
              })}
            </div>
          ) : (
            <EmptyState icon={BookOpen} title="No guides yet" description="Create the first private draft for this workspace." action={canCreate ? <button className="button primary" onClick={onNewGuide}><Plus /> Create guide</button> : undefined} />
          )}
        </section>

        <aside className="card access-summary">
          <div className="section-heading compact"><div><p className="eyebrow">Access model</p><h2>Healthy boundaries</h2></div><ShieldCheck /></div>
          <div className="summary-stat"><span><Users /> Active people</span><strong>{members.filter((item) => item.status === "active").length}</strong></div>
          <div className="summary-stat"><span><Group /> Audience groups</span><strong>{groups.length}</strong></div>
          <div className="summary-stat"><span><LockKeyhole /> Restricted guides</span><strong>{guides.filter((item) => item.restricted).length}</strong></div>
          <p className="privacy-caption"><Shield /> Roles control actions. Audiences independently control who can receive published content.</p>
        </aside>
      </div>
    </div>
  );
}

function GuidesView({
  guides,
  onNew,
  onOpen,
  onEdit,
  onAction,
  busy,
  canCreate,
}: {
  guides: Guide[];
  onNew: () => void;
  onOpen: (guide: Guide) => void;
  onEdit: (guide: Guide) => void;
  onAction: (action: string, payload: unknown, message: string) => Promise<void>;
  busy: boolean;
  canCreate: boolean;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const filtered = guides.filter((guide) => {
    const revision = guide.workingRevision ?? guide.publishedRevision;
    const text = `${guide.title} ${revision?.summary ?? ""} ${revision?.tags.join(" ") ?? ""}`.toLowerCase();
    return text.includes(query.toLowerCase()) && (status === "all" || guide.status === status);
  });

  return (
    <div className="view-stack">
      <div className="page-heading">
        <div><p className="eyebrow">Knowledge library</p><h1>Guides</h1><p>Draft privately, review with context, and publish without interrupting the live revision.</p></div>
        <button className="button primary" type="button" disabled={!canCreate} onClick={onNew}><Plus /> New guide</button>
      </div>
      <section className="card table-card">
        <div className="filter-bar">
          <label className="search-field"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search guides" /></label>
          <label className="select-field"><Filter /><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All lifecycle states</option><option value="draft">Draft</option><option value="review">In review</option><option value="published">Published</option><option value="archived">Archived</option></select><ChevronDown /></label>
          <span className="result-count">{filtered.length} {filtered.length === 1 ? "guide" : "guides"}</span>
        </div>
        {filtered.length ? (
          <div className="guide-table">
            {filtered.map((guide) => {
              const revision = guide.workingRevision ?? guide.publishedRevision;
              const live = guide.publishedRevision;
              return (
                <article className="guide-card" key={guide.id}>
                  <button className="guide-card-main" type="button" onClick={() => onOpen(guide)}>
                    <span className="guide-icon large"><BookOpen /></span>
                    <span className="guide-content">
                      <span className="guide-title-line"><strong>{revision?.title ?? guide.title}</strong>{guide.restricted ? <span className="restricted-label"><LockKeyhole /> Restricted</span> : <span className="workspace-label"><Globe2 /> Workspace</span>}</span>
                      <span className="guide-summary">{revision?.summary || "No description yet."}</span>
                      <span className="guide-meta">{revision?.category || "Uncategorized"} · {revision?.steps.length ?? 0} blocks · Updated {formatDate(guide.updatedAt)}</span>
                    </span>
                  </button>
                  <div className="guide-state-column">
                    <StatusBadge status={guide.status} />
                    {guide.workingRevision && live ? <small>v{live.number} remains live</small> : revision ? <small>Revision {revision.number}</small> : null}
                  </div>
                  <div className="guide-actions">
                    {guide.canEdit && guide.status !== "archived" ? <button className="button ghost small" type="button" onClick={() => onEdit(guide)}>Edit</button> : null}
                    {guide.canReview && guide.status === "review" ? <><button className="button secondary small" disabled={busy} type="button" onClick={() => { if (window.confirm("Approve this revision for publication?")) void onAction("reviewGuide", { guideId: guide.id, decision: "approved" }, "Review approved").catch(() => undefined); }}>Approve</button><button className="button ghost small" disabled={busy} type="button" onClick={() => { if (window.confirm("Return this revision to its author for changes?")) void onAction("reviewGuide", { guideId: guide.id, decision: "changes_requested" }, "Changes requested").catch(() => undefined); }}>Request changes</button></> : null}
                    {guide.canPublish && guide.status === "review" ? <button className="button primary small" disabled={busy} type="button" onClick={() => onAction("publishGuide", { guideId: guide.id }, "New revision published")}>Publish</button> : null}
                    {guide.canPublish && guide.status !== "archived" ? <button className="icon-button" title="Archive guide" disabled={busy} type="button" onClick={() => onAction("archiveGuide", { guideId: guide.id }, "Guide archived")}><Archive /></button> : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : <EmptyState icon={Search} title="No matching guides" description="Try another search or lifecycle filter." />}
      </section>
    </div>
  );
}

function GuideViewer({
  guide,
  workspaceId,
  workspaceName,
  accentColor,
  clickTargetColor,
  initialRevision,
  canExport,
  canRestore,
  busy,
  onClose,
  onEdit,
  onExport,
  onRestore,
  onPublishedViewed,
  onComplete,
}: {
  guide: Guide;
  workspaceId: string;
  workspaceName: string;
  accentColor: string;
  clickTargetColor: string;
  initialRevision?: "working" | "published";
  canExport: boolean;
  canRestore: boolean;
  busy: boolean;
  onClose: () => void;
  onEdit: () => void;
  onExport: (format: "pdf" | "html" | "markdown") => void;
  onRestore: (revisionId: string) => void;
  onPublishedViewed: () => void;
  onComplete: () => void;
}) {
  const [revisionMode, setRevisionMode] = useState<"working" | "published">(
    initialRevision ?? (guide.workingRevision ? "working" : "published"),
  );
  const revision = revisionMode === "working" ? guide.workingRevision : guide.publishedRevision;

  if (!revision) return null;

  const liveParams = new URLSearchParams({ workspaceId, guide: guide.id });
  const liveUrl = `${window.location.origin}${window.location.pathname}?${liveParams}`;
  return (
    <Modal title={revision.title} eyebrow={`${workspaceName} · Revision ${revision.number}`} onClose={onClose} wide>
      <div className="guide-viewer">
        <div className="viewer-toolbar">
          <div className="revision-toggle">
            {guide.workingRevision ? <button type="button" className={revisionMode === "working" ? "active" : ""} onClick={() => setRevisionMode("working")}>Working {guide.workingRevision.status}</button> : null}
            {guide.publishedRevision ? <button type="button" className={revisionMode === "published" ? "active" : ""} onClick={() => { setRevisionMode("published"); onPublishedViewed(); }}>Live v{guide.publishedRevision.number}</button> : null}
          </div>
          <div className="viewer-actions">
            <button className="button ghost small" type="button" onClick={async () => navigator.clipboard.writeText(liveUrl)}><Link2 /> Copy live link</button>
            {canExport && guide.publishedRevision ? (
              <details className="export-menu">
                <summary className="button secondary small"><Download /> Export</summary>
                <div><button type="button" onClick={() => onExport("pdf")}>PDF</button><button type="button" onClick={() => onExport("html")}>HTML</button><button type="button" onClick={() => onExport("markdown")}>Markdown</button></div>
              </details>
            ) : null}
            {revisionMode === "published" && guide.publishedRevision ? <button className="button secondary small" type="button" disabled={busy} onClick={onComplete}><CheckCircle2 /> Mark complete</button> : null}
            {guide.canEdit ? <button className="button primary small" type="button" onClick={onEdit}>Edit draft</button> : null}
          </div>
        </div>
        <header className="document-header">
          <div className="document-meta"><StatusBadge status={revision.status} />{guide.restricted ? <span><LockKeyhole /> Restricted audience</span> : <span><Globe2 /> Entire workspace</span>}</div>
          <h1>{revision.title}</h1>
          <p>{revision.summary}</p>
          <div className="document-facts"><span>{revision.category || "Uncategorized"}</span><span>{revision.steps.length} blocks</span><span>By {revision.authorName}</span>{revision.publishedAt ? <span>Published {formatDate(revision.publishedAt)}</span> : null}</div>
        </header>
        <div className="document-steps">
          {revision.steps.map((step, index) => (
            <section className={`document-step document-${step.kind}`} key={step.id}>
              {step.kind === "action" ? <span className="document-step-number">{index + 1}</span> : null}
              <div>
                <h2>{step.title}</h2>
                {step.description ? <p>{step.description}</p> : null}
                {step.screenshotMediaId ? <AuthorizedMedia workspaceId={workspaceId} mediaId={step.screenshotMediaId} alt={`Redacted screenshot for ${step.title}`} overlay={<ScreenshotAnnotationPreview step={step} accentColor={accentColor} clickTargetColor={clickTargetColor} />} /> : null}
              </div>
            </section>
          ))}
        </div>
        {guide.revisionHistory?.length ? (
          <section className="revision-history">
            <div className="section-heading compact"><div><p className="eyebrow">Governance trail</p><h2>Revision history</h2></div><History /></div>
            {guide.revisionHistory.map((item) => (
              <div className="history-row" key={item.id}>
                <span className="history-number">v{item.number}</span>
                <span><strong>{titleCase(item.status)}</strong><small>Created by {item.authorName} · {formatDate(item.createdAt, true)}</small></span>
                {item.reviewedAt ? <span className="history-check"><Check /> Reviewed</span> : null}
                {item.publishedAt ? <span className="history-check"><Globe2 /> {formatDate(item.publishedAt)}</span> : null}
                {canRestore && !guide.workingRevision ? <button className="button ghost small" disabled={busy} type="button" onClick={() => onRestore(item.id)}><RotateCcw /> Restore as draft</button> : null}
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </Modal>
  );
}

function CaptureView({ onOpenExtension, canCapture }: { onOpenExtension: () => void; canCapture: boolean }) {
  return (
    <div className="view-stack">
      <div className="page-heading"><div><p className="eyebrow">Chrome & Edge</p><h1>Capture a workflow</h1><p>Record clicks and navigation, redact locally, then send an editable private draft to Rivet.</p></div><button className="button primary" type="button" disabled={!canCapture} onClick={onOpenExtension}><Laptop /> Pair extension</button></div>
      <section className="capture-hero card">
        <div className="capture-demo">
          <div className="fake-browser"><div className="fake-browser-top"><span /><span /><span /><div>portal.example.com</div></div><div className="fake-browser-body"><span className="recording-pill"><span /> Recording · portal.example.com</span><div className="capture-target" /><div className="blur-block blur-one" /><div className="blur-block blur-two" /></div></div>
          <div className="capture-controls"><span><Pause /> Pause means zero new events or screenshots</span><span><ShieldCheck /> Redaction happens before upload</span></div>
        </div>
        <div className="capture-copy"><p className="eyebrow">A safer recorder</p><h2>Nothing leaves the browser until privacy review.</h2><p>Rivet captures click context and rasterized screenshots without passwords, clipboard contents, raw keystrokes, incognito sessions, or password-manager pages.</p><ol><li><span>1</span><div><strong>Start with an explicit scope</strong><p>The indicator always shows the current host and recording state.</p></div></li><li><span>2</span><div><strong>Pause instantly</strong><p>Queued events and in-flight screenshots are cancelled when paused.</p></div></li><li><span>3</span><div><strong>Review every image locally</strong><p>Blur emails, form fields, number categories, similar elements, or whole regions.</p></div></li><li><span>4</span><div><strong>Send a private draft</strong><p>The same governed editor handles captured and manual guides.</p></div></li></ol></div>
      </section>
      <section className="privacy-grid">
        {[{ icon: LockKeyhole, title: "Always excluded", copy: "Passwords, clipboard contents, raw keys, incognito, and password managers." }, { icon: Shield, title: "Local Smart Blur", copy: "Emails, selected form fields, configured number categories, and manual regions." }, { icon: Eye, title: "Human privacy gate", copy: "Common-name and long-text hints assist reviewers but never claim guaranteed protection." }].map(({ icon: Icon, title, copy }) => <article className="card privacy-card" key={title}><Icon /><h3>{title}</h3><p>{copy}</p></article>)}
      </section>
    </div>
  );
}

function GroupsView({ groups, busy, onNew, onEdit }: { groups: WorkspaceGroup[]; busy: boolean; onNew: () => void; onEdit: (group: WorkspaceGroup) => void }) {
  return (
    <div className="view-stack"><div className="page-heading"><div><p className="eyebrow">Content audiences</p><h1>Groups</h1><p>People can belong to several groups. Group membership never changes their workspace role.</p></div><button className="button primary" type="button" disabled={busy} onClick={onNew}><Plus /> New group</button></div><section className="card table-card">{groups.length ? <div className="group-grid">{groups.map((group) => <button className="group-card" type="button" disabled={busy || group.kind === "all_members"} key={group.id} onClick={() => onEdit(group)}><span className={`group-icon${group.sensitive ? " sensitive" : ""}`}>{group.sensitive ? <LockKeyhole /> : <Group />}</span><span><strong>{group.name}</strong><small>{group.kind === "all_members" ? "Managed automatically for all active members" : group.description || "No description"}</small></span><span className="group-count"><Users /> {group.memberCount}</span>{group.kind === "all_members" ? <ShieldCheck /> : <ArrowRight />}</button>)}</div> : <EmptyState icon={Group} title="No audience groups" description="Create Finance, Security, All Employees, or another audience." action={!busy ? <button className="button primary" onClick={onNew}><Plus /> New group</button> : undefined} />}</section></div>
  );
}

function GroupDialog({ group, members, busy, onClose, onSave, onDelete }: { group: WorkspaceGroup | null; members: WorkspaceMember[]; busy: boolean; onClose: () => void; onSave: (payload: { id?: string; name: string; description: string; sensitive: boolean; memberIds: string[] }) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const [name, setName] = useState(group?.name ?? ""); const [description, setDescription] = useState(group?.description ?? ""); const [sensitive, setSensitive] = useState(group?.sensitive ?? false); const [memberIds, setMemberIds] = useState(group?.memberIds ?? []);
  return <Modal title={group ? `Edit ${group.name}` : "Create audience group"} eyebrow="Workspace sharing" onClose={onClose}><form className="modal-form" onSubmit={async (event) => { event.preventDefault(); await onSave({ id: group?.id, name: name.trim(), description: description.trim(), sensitive, memberIds }); }}><label className="field"><span>Group name</span><input required minLength={2} value={name} onChange={(event) => setName(event.target.value)} placeholder="Finance" /></label><label className="field"><span>Description</span><textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="People who handle billing and financial operations" /></label><label className="choice-row emphasized"><input type="checkbox" checked={sensitive} onChange={(event) => setSensitive(event.target.checked)} /><span><strong>Sensitive group</strong><small>Membership can only be assigned by an administrator, never by a generic invite.</small></span></label><div className="member-picker"><span className="field-label">Members</span>{members.filter((member) => member.status === "active").map((member) => <label className="choice-row" key={member.id}><input type="checkbox" checked={memberIds.includes(member.userId)} onChange={() => setMemberIds((items) => items.includes(member.userId) ? items.filter((id) => id !== member.userId) : [...items, member.userId])} /><span className="member-choice-avatar">{initials(member.name, member.email)}</span><span><strong>{member.name || member.email}</strong><small>{member.email}</small></span></label>)}</div><footer className="modal-footer">{group ? <button className="button danger-button" type="button" disabled={busy} onClick={() => onDelete(group.id)}><Trash2 /> Delete</button> : <span />}<button className="button secondary" type="button" onClick={onClose}>Cancel</button><button className="button primary" type="submit" disabled={busy || name.trim().length < 2}>{busy ? <LoaderCircle className="spin" /> : <Check />} Save group</button></footer></form></Modal>;
}

function MembersView({ members, invitations, joinRequests, busy, onInvite, onEdit, onApprove, onRevoke }: { members: WorkspaceMember[]; invitations: Invitation[]; joinRequests: NonNullable<BootstrapResponse["activeWorkspace"]>["joinRequests"]; busy: boolean; onInvite: () => void; onEdit: (member: WorkspaceMember) => void; onApprove: (id: string, approve: boolean) => void; onRevoke: (id: string) => void }) {
  const pending = joinRequests.filter((item) => item.status === "pending");
  const [renderedAt] = useState(() => Date.now());
  return (
    <div className="view-stack">
      <div className="page-heading"><div><p className="eyebrow">Workspace access</p><h1>Members & invitations</h1><p>Roles grant actions. Groups decide which published guides each person receives.</p></div><button className="button primary" disabled={busy} onClick={onInvite}><UserPlus /> Create invite link</button></div>
      {pending.length ? <section className="card table-card"><div className="section-heading compact"><div><p className="eyebrow">Needs a decision</p><h2>Domain join requests</h2></div><CircleAlert /></div>{pending.map((request) => <div className="member-row" key={request.id}><span className="avatar">{initials(request.name, request.email)}</span><span className="member-main"><strong>{request.name || request.email}</strong><small>{request.email} · eligible domain, no access yet</small></span><button className="button ghost small" disabled={busy} onClick={() => onApprove(request.id, false)}>Deny</button><button className="button primary small" disabled={busy} onClick={() => onApprove(request.id, true)}><UserCheck /> Approve viewer</button></div>)}</section> : null}
      <section className="card table-card"><div className="section-heading compact"><div><p className="eyebrow">People</p><h2>{members.length} workspace members</h2></div></div><div className="member-table">{members.map((member) => <button className="member-row clickable" disabled={busy} type="button" key={member.id} onClick={() => onEdit(member)}><span className="avatar">{initials(member.name, member.email)}</span><span className="member-main"><strong>{member.name || member.email}</strong><small>{member.email}</small></span><StatusBadge status={member.status} /><span className="role-list">{member.roles.map((role) => <span key={role}>{titleCase(role)}</span>)}{member.capabilities?.includes("vault") ? <span>Vault</span> : null}</span><span className="group-list">{member.groupIds.length} groups</span><ArrowRight /></button>)}</div></section>
      <section className="card table-card"><div className="section-heading compact"><div><p className="eyebrow">Signed links</p><h2>Invitations</h2></div></div>{invitations.length ? invitations.map((invite) => {
        const expired = Date.parse(invite.expiresAt) <= renderedAt;
        const status = invite.revokedAt ? "revoked" : invite.useCount >= invite.maxUses ? "used" : expired ? "expired" : "active";
        return <div className="invite-row" key={invite.id}><span className="invite-icon"><Link2 /></span><span className="member-main"><strong>{invite.label || `${titleCase(invite.role)} invitation`}</strong><small>Expires {formatDate(invite.expiresAt, true)} · {invite.useCount}/{invite.maxUses} uses</small></span><StatusBadge status={status} />{status === "active" ? <button className="button ghost small" disabled={busy} onClick={() => onRevoke(invite.id)}>Revoke</button> : null}</div>;
      }) : <EmptyState icon={Link2} title="No invitation links" description="Create a signed, expiring link with a basic preassigned role." />}</section>
    </div>
  );
}

function MemberDialog({ member, busy, onClose, onSave, onSuspend }: { member: WorkspaceMember; busy: boolean; onClose: () => void; onSave: (roles: WorkspaceRole[], capabilities: Array<"vault">) => Promise<void>; onSuspend: () => Promise<void> }) {
  const [roles, setRoles] = useState(member.roles);
  const [vault, setVault] = useState(member.capabilities?.includes("vault") ?? false);
  return <Modal title={member.name || member.email} eyebrow="Member permissions" onClose={onClose}><div className="modal-form"><div className="identity-card"><span className="avatar large">{initials(member.name, member.email)}</span><span><strong>{member.name || member.email}</strong><small>{member.email}</small></span><StatusBadge status={member.status} /></div><div className="role-picker"><span className="field-label">Workspace roles</span>{WORKSPACE_ROLES.map((role) => <label className="choice-row" key={role}><input type="checkbox" checked={roles.includes(role)} onChange={() => setRoles((items) => items.includes(role) ? items.filter((item) => item !== role) : [...items, role])} /><span><strong>{titleCase(role)}</strong><small>{ROLE_COPY[role]}</small></span></label>)}</div><label className="choice-row emphasized"><input type="checkbox" checked={vault} onChange={(event) => setVault(event.target.checked)} /><span><strong>Encrypted vault access</strong><small>Separate capability for storing and decrypting workspace credentials.</small></span></label><p className="privacy-caption"><Shield /> Changing roles or vault access does not add the member to any content audience.</p><footer className="modal-footer"><button className="button danger-button" type="button" disabled={busy} onClick={onSuspend}>{member.status === "suspended" ? "Restore member" : "Suspend member"}</button><button className="button secondary" type="button" onClick={onClose}>Cancel</button><button className="button primary" type="button" disabled={busy || roles.length === 0} onClick={() => onSave(roles, vault ? ["vault"] : [])}><Check /> Save access</button></footer></div></Modal>;
}

function InviteDialog({ busy, origin, onClose, onCreate }: { busy: boolean; origin: string; onClose: () => void; onCreate: (payload: { label: string; role: WorkspaceRole; expiresInHours: number; maxUses: number }) => Promise<{ token: string } | void> }) {
  const [label, setLabel] = useState(""); const [role, setRole] = useState<WorkspaceRole>("viewer"); const [expires, setExpires] = useState(72); const [maxUses, setMaxUses] = useState(1); const [url, setUrl] = useState("");
  return <Modal title="Create invitation link" eyebrow="Signed workspace access" onClose={onClose}><form className="modal-form" onSubmit={async (event) => { event.preventDefault(); const result = await onCreate({ label: label.trim(), role, expiresInHours: expires, maxUses }); if (result?.token) setUrl(`${origin}/?invite=${encodeURIComponent(result.token)}`); }}>{url ? <div className="created-invite"><CheckCircle2 /><div><strong>Invitation ready</strong><p>The token is shown once. Copy it now.</p></div><div className="copy-field"><input readOnly value={url} /><button className="button secondary" type="button" onClick={() => navigator.clipboard.writeText(url)}><Copy /> Copy</button></div></div> : <><label className="field"><span>Internal label</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="August contractor onboarding" /></label><label className="field"><span>Preassigned basic role</span><select value={role} onChange={(event) => setRole(event.target.value as WorkspaceRole)}>{WORKSPACE_ROLES.filter((item) => item !== "administrator").map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}</select><small>Administrator access must be assigned after membership is verified.</small></label><div className="form-grid two"><label className="field"><span>Expires after</span><select value={expires} onChange={(event) => setExpires(Number(event.target.value))}><option value={24}>24 hours</option><option value={72}>3 days</option><option value={168}>7 days</option><option value={720}>30 days</option></select></label><label className="field"><span>Maximum uses</span><input type="number" min={1} max={100} value={maxUses} onChange={(event) => setMaxUses(Number(event.target.value))} /></label></div><p className="privacy-caption"><LockKeyhole /> Generic links never assign sensitive-group membership. Every redemption requires a verified email and is audited.</p></>}<footer className="modal-footer"><span /><button className="button secondary" type="button" onClick={onClose}>{url ? "Done" : "Cancel"}</button>{!url ? <button className="button primary" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <Link2 />} Create signed link</button> : null}</footer></form></Modal>;
}

function ActivityView({ audits, workspaceId, busy, onBusyChange, onError, onRefresh }: { audits: AuditEvent[]; workspaceId: string; busy: boolean; onBusyChange: (busy: boolean) => void; onError: (message: string) => void; onRefresh: () => Promise<BootstrapResponse> }) {
  const [query, setQuery] = useState(""); const [action, setAction] = useState("all"); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const actions = [...new Set(audits.map((item) => item.action))].sort();
  const fromTime = from ? Date.parse(`${from}T00:00:00`) : Number.NEGATIVE_INFINITY;
  const toTime = to ? Date.parse(`${to}T23:59:59.999`) : Number.POSITIVE_INFINITY;
  const filtered = audits.filter((item) => { const occurredAt = Date.parse(item.occurredAt); return (`${item.action} ${item.actorName} ${item.actorEmail} ${item.targetLabel} ${item.summary}`).toLowerCase().includes(query.toLowerCase()) && (action === "all" || item.action === action) && occurredAt >= fromTime && occurredAt <= toTime; });
  async function exportCsv() { onBusyChange(true); onError(""); try { await downloadAuditCsv(workspaceId, { action: action === "all" ? undefined : action, from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined, to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined }); await onRefresh(); } catch (error) { onError(messageFromError(error)); } finally { onBusyChange(false); } }
  return <div className="view-stack"><div className="page-heading"><div><p className="eyebrow">Append-only history</p><h1>Activity</h1><p>Trusted server operations record access and governance events. Existing events cannot be changed or deleted.</p></div><button className="button secondary" disabled={busy || Boolean(from && to && from > to)} onClick={() => void exportCsv()}><FileDown /> Export filtered CSV</button></div><section className="card table-card"><div className="filter-bar"><label className="search-field"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search loaded activity" /></label><label className="select-field"><Filter /><select value={action} onChange={(event) => setAction(event.target.value)}><option value="all">All event types</option>{actions.map((item) => <option value={item} key={item}>{item}</option>)}</select><ChevronDown /></label><label className="date-filter"><span>From</span><input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label><label className="date-filter"><span>To</span><input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label><span className="result-count">{filtered.length} loaded events</span></div>{query ? <p className="filter-note">Text search filters the loaded activity list only. The audited CSV export includes the complete server history matching event type and date filters.</p> : null}<div className="audit-list">{filtered.map((event) => <article className="audit-row" key={event.id}><span className="audit-sequence">#{event.sequence}</span><span className="audit-dot" /><span className="audit-main"><strong>{event.summary}</strong><small>{event.actorName || event.actorEmail} · {event.action} · {formatDate(event.occurredAt, true)}</small></span><span className="audit-target"><small>{titleCase(event.targetType)}</small><strong>{event.targetLabel || event.targetId}</strong></span></article>)}</div>{!filtered.length ? <EmptyState icon={Activity} title="No matching events" description="Try a broader activity filter." /> : null}</section></div>;
}

function SettingsView({ workspaceId, initial, busy, onSave, onRefresh }: { workspaceId: string; initial: WorkspaceSettings; busy: boolean; onSave: (settings: WorkspaceSettings) => Promise<void>; onRefresh: () => Promise<BootstrapResponse> }) {
  const [settings, setSettings] = useState(initial); const [domains, setDomains] = useState(initial.allowedDomains.join("\n")); const [hosts, setHosts] = useState(initial.excludedCaptureHosts.join("\n")); const [logoBusy, setLogoBusy] = useState(false); const [logoError, setLogoError] = useState("");
  const update = <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));
  const disabled = busy || logoBusy;
  const uniqueList = (value: string) => [...new Set(value.split(/\r?\n|,/).map((item) => item.trim().toLowerCase()).filter(Boolean))];
  async function refreshLogoState() { const refreshed = await onRefresh(); const logoUrl = refreshed.activeWorkspace?.workspace.settings.logoUrl; setSettings((current) => ({ ...current, logoUrl: logoUrl ?? null })); }
  return <div className="view-stack"><div className="page-heading"><div><p className="eyebrow">Workspace administration</p><h1>Settings & policies</h1><p>Control identity eligibility, capture boundaries, branding, and restricted exports.</p></div><button className="button primary" disabled={disabled} onClick={() => onSave({ ...settings, allowedDomains: uniqueList(domains), excludedCaptureHosts: uniqueList(hosts) })}><Check /> Save settings</button></div><div className="settings-grid"><section className="card settings-card"><div className="settings-title"><span><Paintbrush /></span><div><h2>Document identity</h2><p>Applied to the app and generated guide exports.</p></div></div><div className="logo-upload"><div><strong>{settings.logoUrl ? "Workspace logo configured" : "No workspace logo"}</strong><small>PNG or JPEG, up to 1 MB. The stored identifier remains private.</small></div><label className={`button secondary small${disabled ? " disabled" : ""}`}><ImagePlus /> {settings.logoUrl ? "Replace logo" : "Upload logo"}<input className="visually-hidden" type="file" accept="image/png,image/jpeg" disabled={disabled} onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; setLogoError(""); if (!(["image/png", "image/jpeg"] as string[]).includes(file.type) || file.size > 1024 * 1024) { setLogoError("Choose a PNG or JPEG logo no larger than 1 MB."); return; } setLogoBusy(true); try { await uploadWorkspaceLogo(workspaceId, file); await refreshLogoState(); } catch (error) { setLogoError(messageFromError(error)); } finally { setLogoBusy(false); } }} /></label>{settings.logoUrl ? <button className="button ghost small" type="button" disabled={disabled} onClick={async () => { setLogoBusy(true); setLogoError(""); try { await removeWorkspaceLogo(workspaceId); await refreshLogoState(); } catch (error) { setLogoError(messageFromError(error)); } finally { setLogoBusy(false); } }}><Trash2 /> Remove</button> : null}</div>{logoError ? <p className="form-error" role="alert">{logoError}</p> : null}<div className="form-grid two"><label className="field color-field"><span>Accent color</span><span><input type="color" value={settings.accentColor} onChange={(event) => update("accentColor", event.target.value)} /><input value={settings.accentColor} onChange={(event) => update("accentColor", event.target.value)} /></span></label><label className="field color-field"><span>Click target</span><span><input type="color" value={settings.clickTargetColor} onChange={(event) => update("clickTargetColor", event.target.value)} /><input value={settings.clickTargetColor} onChange={(event) => update("clickTargetColor", event.target.value)} /></span></label></div><label className="choice-row emphasized"><input type="checkbox" checked={settings.removeBranding} onChange={(event) => update("removeBranding", event.target.checked)} /><span><strong>Remove Rivet branding</strong><small>Available as a workspace or subscription entitlement.</small></span></label></section><section className="card settings-card"><div className="settings-title"><span><Mail /></span><div><h2>Approved email domains</h2><p>Eligibility only. Administrators still approve each join request.</p></div></div><label className="field"><span>One exact domain per line</span><textarea rows={6} value={domains} onChange={(event) => setDomains(event.target.value)} placeholder={"example.com\nsubsidiary.co.uk"} /></label><p className="privacy-caption"><ShieldCheck /> Subdomains do not match unless listed explicitly. Consumer lookalikes and suffix matches are rejected.</p></section><section className="card settings-card"><div className="settings-title"><span><Laptop /></span><div><h2>Capture policy</h2><p>Blocked hosts are enforced by the paired extension.</p></div></div><label className="field"><span>Excluded hostnames</span><textarea rows={6} value={hosts} onChange={(event) => setHosts(event.target.value)} placeholder={"vault.example.com\npasswords.example.net"} /></label><p className="privacy-caption"><LockKeyhole /> Password managers, browser internals, extension pages, and incognito sessions are always blocked.</p></section><section className="card settings-card"><div className="settings-title"><span><FileDown /></span><div><h2>Export controls</h2><p>Live links always retain audience checks.</p></div></div><label className="choice-row emphasized"><input type="checkbox" checked={settings.allowRestrictedExports} onChange={(event) => update("allowRestrictedExports", event.target.checked)} /><span><strong>Allow restricted-guide exports</strong><small>Each permitted export is recorded in the audit history.</small></span></label><label className="choice-row emphasized"><input type="checkbox" checked={settings.watermarkExports} onChange={(event) => update("watermarkExports", event.target.checked)} /><span><strong>Watermark exports</strong><small>Add viewer, workspace, and export date to generated files.</small></span></label></section></div></div>;
}

function vaultMetadata(item: VaultItem | null) {
  try {
    const value = JSON.parse(item?.metadataJson ?? "{}") as Record<string, unknown>;
    return {
      username: typeof value.username === "string" ? value.username : "",
      url: typeof value.url === "string" ? value.url : "",
      notes: typeof value.notes === "string" ? value.notes : "",
    };
  } catch {
    return { username: "", url: "", notes: "" };
  }
}

function VaultView({ items, busy, onNew, onEdit, onReveal, onDelete }: { items: VaultItem[]; busy: boolean; onNew: () => void; onEdit: (item: VaultItem) => void; onReveal: (item: VaultItem) => void; onDelete: (item: VaultItem) => void }) {
  return <div className="view-stack"><div className="page-heading"><div><p className="eyebrow">Encrypted credentials</p><h1>Vault</h1><p>Keep credentials out of guides. Secrets are encrypted and decrypted only in this browser with your passphrase.</p></div><button className="button primary" type="button" disabled={busy} onClick={onNew}><Plus /> New vault item</button></div><section className="card table-card">{items.length ? <div className="vault-list">{items.map((item) => { const metadata = vaultMetadata(item); return <article className="vault-row" key={item.id}><span className="vault-icon"><KeyRound /></span><span className="member-main"><strong>{item.title}</strong><small>{metadata.username || metadata.url || "Encrypted workspace credential"} · updated {formatDate(item.updatedAt)}</small></span><button className="button secondary small" type="button" disabled={busy} onClick={() => onReveal(item)}><Eye /> Reveal</button><button className="button ghost small" type="button" disabled={busy} onClick={() => onEdit(item)}>Edit details</button><button className="icon-button danger" type="button" disabled={busy} aria-label={`Delete ${item.title}`} onClick={() => onDelete(item)}><Trash2 /></button></article>; })}</div> : <EmptyState icon={KeyRound} title="No vault items" description="Store the first encrypted credential instead of embedding it in a restricted guide." action={<button className="button primary" type="button" disabled={busy} onClick={onNew}><Plus /> New vault item</button>} />}</section><p className="privacy-caption"><ShieldCheck /> Rivet stores only an authenticated encryption envelope. Passphrases and plaintext are never sent to the server or audit log.</p></div>;
}

function VaultEditorDialog({ item, busy, onClose, onSave }: { item: VaultItem | null; busy: boolean; onClose: () => void; onSave: (payload: { id?: string; title: string; encryptedEnvelopeJson: string; metadataJson: string }) => Promise<void> }) {
  const metadata = vaultMetadata(item);
  const [title, setTitle] = useState(item?.title ?? "");
  const [username, setUsername] = useState(metadata.username);
  const [url, setUrl] = useState(metadata.url);
  const [notes, setNotes] = useState(metadata.notes);
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  return <Modal title={item ? `Edit ${item.title}` : "New vault item"} eyebrow="Client-side encryption" onClose={onClose}><form className="modal-form" onSubmit={async (event) => { event.preventDefault(); setError(""); try { let encryptedEnvelopeJson = item?.encryptedEnvelopeJson ?? ""; if (secret) { if (passphrase.length < 12) throw new Error("Use a vault passphrase of at least 12 characters."); encryptedEnvelopeJson = JSON.stringify(await encryptSecretValue(secret, passphrase)); } if (!encryptedEnvelopeJson) throw new Error("Enter the secret value and a vault passphrase."); await onSave({ ...(item ? { id: item.id } : {}), title: title.trim(), encryptedEnvelopeJson, metadataJson: JSON.stringify({ username: username.trim(), url: url.trim(), notes: notes.trim() }) }); setSecret(""); setPassphrase(""); } catch (nextError) { setError(messageFromError(nextError)); } }}><label className="field"><span>Title</span><input required minLength={2} maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Microsoft 365 break-glass account" /></label><div className="form-grid two"><label className="field"><span>Username or account</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" /></label><label className="field"><span>Sign-in URL</span><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://login.example.com" /></label></div><label className="field"><span>{item ? "Replacement secret (optional)" : "Secret value"}</span><textarea required={!item} rows={3} value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" spellCheck={false} /></label><label className="field"><span>Vault passphrase {item ? "(required only when replacing the secret)" : ""}</span><input type="password" required={!item || Boolean(secret)} minLength={12} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="new-password" /></label><label className="field"><span>Non-secret notes</span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>{error ? <p className="form-error" role="alert">{error}</p> : null}<footer className="modal-footer"><span /><button className="button secondary" type="button" onClick={onClose}>Cancel</button><button className="button primary" type="submit" disabled={busy || title.trim().length < 2}>{busy ? <LoaderCircle className="spin" /> : <ShieldCheck />} Encrypt & save</button></footer></form></Modal>;
}

function VaultRevealDialog({ item, busy, onClose }: { item: VaultItem; busy: boolean; onClose: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [plaintext, setPlaintext] = useState("");
  const [error, setError] = useState("");
  return <Modal title={item.title} eyebrow="Decrypt in this browser" onClose={onClose}><div className="modal-form">{plaintext ? <div className="revealed-secret"><span className="field-label">Decrypted value</span><pre>{plaintext}</pre><button className="button secondary" type="button" onClick={() => void navigator.clipboard.writeText(plaintext)}><Copy /> Copy value</button></div> : <><label className="field"><span>Vault passphrase</span><input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="current-password" onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} /></label><button className="button primary" type="button" disabled={busy || !passphrase} onClick={async () => { setError(""); try { const envelope = JSON.parse(item.encryptedEnvelopeJson) as EncryptedSecretEnvelope; setPlaintext(await decryptSecretValue(envelope, passphrase)); setPassphrase(""); } catch (nextError) { setError(messageFromError(nextError)); } }}><Eye /> Decrypt locally</button></>}{error ? <p className="form-error" role="alert">{error}</p> : null}<p className="privacy-caption"><LockKeyhole /> Closing this dialog removes the decrypted value from Rivet&apos;s UI state.</p><footer className="modal-footer"><span /><button className="button primary" type="button" onClick={onClose}>Close</button></footer></div></Modal>;
}

export function PlatformView({ platform, busy, onStatus, onAssign }: { platform: NonNullable<BootstrapResponse["platform"]>; busy: boolean; onStatus: (workspaceId: string, status: "active" | "suspended" | "archived") => void; onAssign: (workspace: PlatformWorkspace) => void }) {
  const { metrics, workspaces } = platform;
  return <div className="view-stack"><div className="page-heading"><div><p className="eyebrow">Product owner</p><h1>Platform administration</h1><p>Manage tenant health and aggregate usage without opening customer document contents or secrets.</p></div><span className="platform-shield"><ShieldCheck /> Content-private metrics</span></div><section className="metric-grid platform-metrics"><MetricCard label="Users" value={metrics.users} hint="Across all workspaces" icon={Users} /><MetricCard label="Active workspaces" value={metrics.activeWorkspaces} hint={`${metrics.suspendedWorkspaces} suspended · ${metrics.archivedWorkspaces} archived`} icon={Building2} tone="accent" /><MetricCard label="Guides" value={metrics.published + metrics.drafts} hint={`${metrics.published} published · ${metrics.drafts} drafts`} icon={BookOpen} /><MetricCard label="Captures" value={metrics.captures} hint={`${metrics.failedOperations} failed operations`} icon={Sparkles} /><MetricCard label="Views" value={metrics.views} hint={`${metrics.completions} completions`} icon={Eye} /><MetricCard label="Exports" value={metrics.exports} hint={formatBytes(metrics.storageBytes)} icon={FileDown} /></section><section className="card table-card"><div className="section-heading"><div><p className="eyebrow">Tenant directory</p><h2>Every workspace</h2></div><span className="privacy-caption"><LockKeyhole /> Metadata only</span></div><div className="platform-table"><div className="platform-row platform-head"><span>Workspace</span><span>Administrators</span><span>Guides</span><span>Usage</span><span>Storage</span><span>Status</span><span /></div>{workspaces.map((workspace) => <div className="platform-row" key={workspace.id}><span className="workspace-cell"><span className="workspace-avatar">{workspace.name.slice(0, 1)}</span><span><strong>{workspace.name}</strong><small>{workspace.memberCount} members · created {formatDate(workspace.createdAt)}</small></span></span><span>{workspace.administrators.length ? workspace.administrators.map((admin) => <small key={admin.userId}>{admin.name || admin.email}</small>) : <small>None assigned</small>}<button className="text-button" onClick={() => onAssign(workspace)}><UserCog /> Assign</button></span><span><strong>{workspace.publishedCount}</strong><small>{workspace.draftCount} drafts</small></span><span><strong>{workspace.views} views</strong><small>{workspace.exports} exports</small></span><span>{formatBytes(workspace.storageBytes)}</span><span><StatusBadge status={workspace.status} /></span><span><details className="row-menu"><summary className="icon-button"><MoreHorizontal /></summary><div>{workspace.status !== "active" ? <button disabled={busy} onClick={() => onStatus(workspace.id, "active")}><RefreshCw /> Restore</button> : null}{workspace.status === "active" ? <button disabled={busy} onClick={() => onStatus(workspace.id, "suspended")}><Pause /> Suspend</button> : null}{workspace.status !== "archived" ? <button disabled={busy} onClick={() => onStatus(workspace.id, "archived")}><Archive /> Archive</button> : null}</div></details></span></div>)}</div></section></div>;
}

function ExtensionDialog({ busy, onClose, onPair, onRevoke }: { busy: boolean; onClose: () => void; onPair: () => Promise<{ code: string; expiresAt: string }>; onRevoke: () => Promise<void> }) {
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  async function revokeDevices() {
    if (!window.confirm("Revoke every browser paired by your account in this workspace?")) return;
    await onRevoke();
    setPairing(null);
  }
  return (
    <Modal title="Pair the capture extension" eyebrow="Chrome & Edge" onClose={onClose}>
      <div className="modal-form">
        <ol className="pairing-steps">
          <li><span>1</span><div><strong>Install the Rivet extension</strong><p>Download the packaged extension, unzip it, then load the folder through your browser&apos;s extension developer mode.</p><a className="button secondary" href="/rivet-extension.zip" download><Download /> Download extension</a></div></li>
          <li><span>2</span><div><strong>Generate a one-time code</strong><p>The code expires quickly and can pair only one browser profile with this workspace.</p>{pairing ? <div className="pairing-code"><code>{pairing.code}</code><button className="icon-button" onClick={() => navigator.clipboard.writeText(pairing.code)}><Copy /></button><small>Expires {formatDate(pairing.expiresAt, true)}</small></div> : <button className="button primary" disabled={busy} onClick={() => { void onPair().then(setPairing).catch(() => undefined); }}>{busy ? <LoaderCircle className="spin" /> : <Link2 />} Generate pairing code</button>}</div></li>
          <li><span>3</span><div><strong>Enter the code in the extension</strong><p>The extension receives a revocable, workspace-scoped device token—not your Appwrite session or password.</p><button className="button ghost small" type="button" disabled={busy} onClick={() => { void revokeDevices().catch(() => undefined); }}><Trash2 /> Revoke my paired browsers</button></div></li>
        </ol>
        <p className="privacy-caption"><ShieldCheck /> Pairing, capture uploads, and device revocation are audited for workspace administrators.</p>
        <footer className="modal-footer"><span /><button className="button primary" onClick={onClose}>Done</button></footer>
      </div>
    </Modal>
  );
}

export function RivetWorkspaceApp({
  data,
  activeWorkspaceId,
  busy,
  globalError,
  onSelectWorkspace,
  onRefresh,
  onSignOut,
  onBusyChange,
  onError,
}: {
  data: BootstrapResponse;
  activeWorkspaceId: string;
  busy: boolean;
  globalError: string;
  onSelectWorkspace: (id: string) => Promise<void>;
  onRefresh: () => Promise<BootstrapResponse>;
  onSignOut: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string) => void;
}) {
  const active = data.activeWorkspace!;
  const { workspace, guides, groups, members, invitations, joinRequests, audits } = active;
  const vaultItems = active.vaultItems ?? [];
  const [view, setView] = useState<View>("Overview");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toast, setToast] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const { preference, setPreference } = useTheme();
  const roles = workspace.roles;
  const isAdmin = roles.includes("administrator");
  const canCreate = isAdmin || roles.includes("creator");
  const workspaceMutable = workspace.status === "active";
  const canCapture = canCreate && workspaceMutable;
  const currentMember = members.find((member) => member.userId === data.viewer.id);
  const canUseVault = currentMember?.capabilities?.includes("vault") ?? false;
  const linkedGuideHandled = useRef("");

  const recordPublishedView = useCallback((guide: Guide) => {
    if (!guide.publishedRevision) return;
    void rivetCommand("recordGuideView", {
      workspaceId: workspace.id,
      guideId: guide.id,
    }).catch(() => undefined);
  }, [workspace.id]);

  const openGuide = useCallback((guide: Guide, initialRevision?: "working" | "published") => {
    const resolved = initialRevision ?? (guide.workingRevision ? "working" : "published");
    setDialog({ type: "guide", guide, initialRevision: resolved });
    if (resolved === "published") recordPublishedView(guide);
  }, [recordPublishedView]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 3_500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const scopedKey = `rivet-theme:${data.viewer.id}`;
    const stored = window.localStorage.getItem(scopedKey);
    const next = stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : data.viewer.themePreference ?? "system";
    const frame = window.requestAnimationFrame(() => setPreference(next));
    return () => window.cancelAnimationFrame(frame);
  }, [data.viewer.id, data.viewer.themePreference, setPreference]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setDialog(null);
      setNavOpen(false);
      setProfileOpen(false);
      setView((current) => {
        if (current === "Platform") return data.viewer.platformAdministrator ? current : "Overview";
        if (current === "Vault") return canUseVault ? current : "Overview";
        if (["Groups", "Members", "Activity", "Settings"].includes(current) && !isAdmin) return "Overview";
        return current;
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canUseVault, data.viewer.platformAdministrator, isAdmin, workspace.id]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkedWorkspaceId = params.get("workspaceId");
    const guideId = params.get("guide");
    if (!guideId || (linkedWorkspaceId && linkedWorkspaceId !== workspace.id)) return;
    const guide = guides.find((item) => item.id === guideId);
    if (!guide) return;
    const edit = params.get("edit") === "1";
    const key = `${workspace.id}:${guideId}:${edit ? "edit" : "view"}`;
    if (linkedGuideHandled.current === key) return;
    const frame = window.requestAnimationFrame(() => {
      linkedGuideHandled.current = key;
      setView("Guides");
      if (edit && guide.canEdit && workspaceMutable) {
        setDialog({ type: "guide-editor", guide });
      } else {
        openGuide(guide, "published");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [guides, openGuide, workspace.id, workspaceMutable]);

  async function command<T = unknown>(action: string, payload: unknown, success: string) {
    onBusyChange(true); onError("");
    try {
      const result = await rivetCommand<T>(action, { workspaceId: workspace.id, ...((payload ?? {}) as object) });
      await onRefresh();
      if (success) setToast(success);
      return result;
    } catch (error) {
      onError(messageFromError(error));
      throw error;
    } finally { onBusyChange(false); }
  }

  async function saveGuide(payload: GuideEditorPayload) {
    await command("saveGuide", payload, payload.transition === "review" ? "Draft sent for review" : "Private draft saved");
    setDialog(null);
  }

  const visibleNav = [
    ...NAV_ITEMS.filter((item) => {
      if (item.view === "Vault") return canUseVault;
      if (["Groups", "Members", "Activity", "Settings"].includes(item.view)) return isAdmin;
      return true;
    }),
    ...(data.viewer.platformAdministrator ? [{ view: "Platform" as const, icon: Shield }] : []),
  ];
  const viewedGuide = dialog?.type === "guide"
    ? guides.find((guide) => guide.id === dialog.guide.id) ?? null
    : null;
  const editorDialogGuide = dialog?.type === "guide-editor" && dialog.guide
    ? guides.find((guide) => guide.id === dialog.guide!.id) ?? null
    : null;
  const canShowEditorDialog = Boolean(
    dialog?.type === "guide-editor" &&
      workspaceMutable &&
      (dialog.guide === null ? canCreate : editorDialogGuide?.canEdit),
  );
  const publishedRestricted = Boolean(
    viewedGuide?.publishedRevision &&
      !viewedGuide.publishedRevision.audiences.some((item) => item.kind === "workspace"),
  );
  const viewedGuideAuthor = viewedGuide?.workingRevision?.authorId ?? viewedGuide?.publishedRevision?.authorId;
  const canRestoreViewedGuide = Boolean(
    workspaceMutable &&
      viewedGuide &&
      (isAdmin || (roles.includes("creator") && viewedGuideAuthor === data.viewer.id)),
  );

  return (
    <div className="app-shell" style={{ "--workspace-accent": workspace.settings.accentColor, "--click-color": workspace.settings.clickTargetColor } as React.CSSProperties}>
      <aside className={`sidebar${navOpen ? " sidebar-open" : ""}`}>
        <div className="sidebar-brand"><span className="brand-mark">R</span><span>Rivet</span><button className="icon-button sidebar-close" onClick={() => setNavOpen(false)}><X /></button></div>
        <div className="workspace-switcher-wrap"><button className="workspace-switcher" type="button"><span className="workspace-avatar">{workspace.name.slice(0, 1).toUpperCase()}</span><span><strong>{workspace.name}</strong><small>{roles.map(titleCase).join(" · ")}</small></span><ChevronDown /></button><select aria-label="Switch workspace" value={activeWorkspaceId} disabled={busy} onChange={(event) => void onSelectWorkspace(event.target.value)}>{data.workspaces.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div>
        <nav className="main-nav" aria-label="Main navigation">{visibleNav.map(({ view: item, icon: Icon }) => <button className={view === item ? "active" : ""} type="button" key={item} onClick={() => { setView(item); setNavOpen(false); }}><Icon /><span>{item}</span>{item === "Guides" && active.metrics.reviews ? <small>{active.metrics.reviews}</small> : null}</button>)}</nav>
        <div className="sidebar-privacy"><ShieldCheck /><div><strong>Default deny</strong><p>Every data request is checked by the trusted server.</p></div></div>
        <button className="capture-shortcut" type="button" disabled={!canCapture} onClick={() => setDialog({ type: "extension" })}><span><Sparkles /></span><span><strong>Capture workflow</strong><small>{canCapture ? "Chrome & Edge extension" : "Creator access required"}</small></span><ArrowRight /></button>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setNavOpen(true)} aria-label="Open navigation"><Menu /></button>
          <div className="topbar-context"><span className="workspace-status-dot" /><span>{workspace.name}</span><StatusBadge status={workspace.status} /></div>
          <div className="topbar-actions">
            <label className="theme-select" title="Theme"><span aria-hidden="true">{preference === "dark" ? <Moon /> : preference === "light" ? <Sun /> : <Laptop />}</span><select value={preference} onChange={(event) => { const theme = event.target.value as "light" | "dark" | "system"; window.localStorage.setItem(`rivet-theme:${data.viewer.id}`, theme); setPreference(theme); void rivetCommand("updateTheme", { theme }).catch((error) => onError(messageFromError(error))); }} aria-label="Theme"><option value="system">System theme</option><option value="light">Light theme</option><option value="dark">Dark theme</option></select></label>
            <button className="button primary top-create" type="button" disabled={busy || (view === "Platform" ? !data.viewer.platformAdministrator : !canCreate || !workspaceMutable)} onClick={() => setDialog(view === "Platform" ? { type: "platform-create" } : { type: "guide-editor", guide: null })}><Plus /> {view === "Platform" ? "Workspace" : "Create"}</button>
            <div className="profile-wrap"><button className="profile-button" type="button" onClick={() => setProfileOpen((open) => !open)}><span className="avatar">{initials(data.viewer.name, data.viewer.email)}</span><span><strong>{data.viewer.name}</strong><small>{data.viewer.email}</small></span><ChevronDown /></button>{profileOpen ? <div className="profile-menu"><div><strong>{data.viewer.name}</strong><small>{data.viewer.email}</small></div><button type="button" onClick={onSignOut}><LogOut /> Sign out</button></div> : null}</div>
          </div>
        </header>
        {workspace.status !== "active" ? <div className="suspension-banner"><CircleAlert /><span>This workspace is {workspace.status}. Changes and captures are disabled until a platform administrator restores it.</span></div> : null}
        {globalError ? <div className="global-error" role="alert"><CircleAlert /><span>{globalError}</span><button className="icon-button" onClick={() => onError("")}><X /></button></div> : null}
        <main className="content-area">
          {view === "Overview" ? <OverviewView data={active} canCreate={canCreate && workspaceMutable} canCapture={canCapture} onNewGuide={() => setDialog({ type: "guide-editor", guide: null })} onOpenGuide={(guide) => openGuide(guide)} onNavigate={setView} /> : null}
          {view === "Guides" ? <GuidesView guides={guides} canCreate={canCreate && workspaceMutable} onNew={() => setDialog({ type: "guide-editor", guide: null })} onOpen={(guide) => openGuide(guide)} onEdit={(guide) => setDialog({ type: "guide-editor", guide })} onAction={command} busy={busy || !workspaceMutable} /> : null}
          {view === "Capture" ? <CaptureView canCapture={canCapture} onOpenExtension={() => setDialog({ type: "extension" })} /> : null}
          {view === "Groups" && isAdmin ? <GroupsView groups={groups} busy={busy || !workspaceMutable} onNew={() => setDialog({ type: "group", group: null })} onEdit={(group) => setDialog({ type: "group", group })} /> : null}
          {view === "Members" && isAdmin ? <MembersView members={members} invitations={invitations} joinRequests={joinRequests} busy={busy || !workspaceMutable} onInvite={() => setDialog({ type: "invite" })} onEdit={(member) => setDialog({ type: "member", member })} onApprove={(joinRequestId, approve) => { void command("resolveJoinRequest", { joinRequestId, approve }, approve ? "Member approved as viewer" : "Join request denied").catch(() => undefined); }} onRevoke={(invitationId) => { void command("revokeInvite", { invitationId }, "Invitation revoked").catch(() => undefined); }} /> : null}
          {view === "Vault" && canUseVault ? <VaultView items={vaultItems} busy={busy || !workspaceMutable} onNew={() => setDialog({ type: "vault-editor", item: null })} onEdit={(item) => setDialog({ type: "vault-editor", item })} onReveal={(item) => setDialog({ type: "vault-reveal", item })} onDelete={(item) => { if (window.confirm(`Delete ${item.title}? This encrypted item cannot be recovered.`)) void command("deleteVaultItem", { vaultItemId: item.id }, "Vault item deleted").catch(() => undefined); }} /> : null}
          {view === "Activity" && isAdmin ? <ActivityView audits={audits} workspaceId={workspace.id} busy={busy} onBusyChange={onBusyChange} onError={onError} onRefresh={onRefresh} /> : null}
          {view === "Settings" && isAdmin ? <SettingsView key={workspace.id} workspaceId={workspace.id} initial={workspace.settings} busy={busy || !workspaceMutable} onRefresh={onRefresh} onSave={async (settings) => { await command("updateWorkspaceSettings", { settings }, "Workspace policies saved"); }} /> : null}
          {view === "Platform" && data.viewer.platformAdministrator && data.platform ? <PlatformView platform={data.platform} busy={busy} onStatus={(workspaceId, status) => { if (window.confirm(`${titleCase(status)} this workspace?`)) void command("setWorkspaceStatus", { targetWorkspaceId: workspaceId, status }, `Workspace ${status}`).catch(() => undefined); }} onAssign={(target) => setDialog({ type: "assign-admin", workspace: target })} /> : null}
        </main>
      </div>

      {dialog?.type === "guide-editor" && canShowEditorDialog ? <GuideEditor guide={dialog.guide ? editorDialogGuide! : null} workspace={workspace} groups={groups} members={members} busy={busy || !workspaceMutable} onClose={() => setDialog(null)} onSave={saveGuide} onMediaChanged={onRefresh} /> : null}
      {dialog?.type === "guide" && viewedGuide ? <GuideViewer guide={viewedGuide} workspaceId={workspace.id} workspaceName={workspace.name} accentColor={workspace.settings.accentColor} clickTargetColor={workspace.settings.clickTargetColor} initialRevision={dialog.initialRevision} canExport={Boolean(viewedGuide.publishedRevision) && (!publishedRestricted || workspace.settings.allowRestrictedExports)} canRestore={canRestoreViewedGuide} busy={busy || !workspaceMutable} onClose={() => setDialog(null)} onEdit={() => setDialog({ type: "guide-editor", guide: viewedGuide })} onPublishedViewed={() => recordPublishedView(viewedGuide)} onComplete={() => { void command("recordGuideCompletion", { guideId: viewedGuide.id }, "Guide marked complete").catch(() => undefined); }} onExport={async (format) => { onBusyChange(true); onError(""); try { await downloadAuthorizedExport(workspace.id, viewedGuide.id, format); setToast(`${format.toUpperCase()} export created`); await onRefresh(); } catch (error) { onError(messageFromError(error)); } finally { onBusyChange(false); } }} onRestore={(revisionId) => { void command("restoreRevision", { guideId: viewedGuide.id, revisionId }, "Revision restored as a private draft").then(() => setDialog(null)).catch(() => undefined); }} /> : null}
      {dialog?.type === "group" && isAdmin && workspaceMutable ? <GroupDialog group={dialog.group} members={members} busy={busy} onClose={() => setDialog(null)} onSave={async (payload) => { await command("saveGroup", payload, payload.id ? "Group updated" : "Group created"); setDialog(null); }} onDelete={async (groupId) => { await command("deleteGroup", { groupId }, "Group deleted"); setDialog(null); }} /> : null}
      {dialog?.type === "member" && isAdmin && workspaceMutable ? <MemberDialog member={dialog.member} busy={busy} onClose={() => setDialog(null)} onSave={async (nextRoles, capabilities) => { await command("updateMember", { memberId: dialog.member.id, roles: nextRoles, capabilities, status: dialog.member.status }, "Member access updated"); setDialog(null); }} onSuspend={async () => { await command("updateMember", { memberId: dialog.member.id, roles: dialog.member.roles, capabilities: dialog.member.capabilities ?? [], status: dialog.member.status === "suspended" ? "active" : "suspended" }, dialog.member.status === "suspended" ? "Member restored" : "Member suspended"); setDialog(null); }} /> : null}
      {dialog?.type === "invite" && isAdmin && workspaceMutable ? <InviteDialog busy={busy} origin={window.location.origin} onClose={() => setDialog(null)} onCreate={(payload) => command<{ token: string }>("createInvite", payload, "Invitation created")} /> : null}
      {dialog?.type === "extension" && canCapture ? <ExtensionDialog busy={busy} onClose={() => setDialog(null)} onPair={() => command<{ code: string; expiresAt: string }>("createPairingCode", {}, "Pairing code created")} onRevoke={() => command("revokeCaptureDevices", {}, "Paired browser access revoked")} /> : null}
      {dialog?.type === "platform-create" && data.viewer.platformAdministrator ? <PlatformCreateDialog busy={busy} onClose={() => setDialog(null)} onCreate={async (name) => { await command("createWorkspace", { name }, "Workspace created"); setDialog(null); }} /> : null}
      {dialog?.type === "assign-admin" && data.viewer.platformAdministrator ? <AssignAdminDialog workspace={dialog.workspace} busy={busy} onClose={() => setDialog(null)} onAssign={async (email) => { await command("assignWorkspaceAdministrator", { targetWorkspaceId: dialog.workspace.id, email }, "Workspace administrator assigned"); setDialog(null); }} /> : null}
      {dialog?.type === "vault-editor" && canUseVault && workspaceMutable ? <VaultEditorDialog item={dialog.item} busy={busy} onClose={() => setDialog(null)} onSave={async (payload) => { await command("saveVaultItem", payload, "Vault item encrypted and saved"); setDialog(null); }} /> : null}
      {dialog?.type === "vault-reveal" && canUseVault ? <VaultRevealDialog item={dialog.item} busy={busy} onClose={() => setDialog(null)} /> : null}
      {busy ? <div className="busy-indicator" role="status"><LoaderCircle className="spin" /> Working securely…</div> : null}
      {toast ? <div className="toast" role="status"><CheckCircle2 /> {toast}</div> : null}
    </div>
  );
}

function PlatformCreateDialog({ busy, onClose, onCreate }: { busy: boolean; onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  return <Modal title="Create a workspace" eyebrow="Platform administration" onClose={onClose}><form className="modal-form" onSubmit={async (event: FormEvent) => { event.preventDefault(); await onCreate(name.trim()); }}><p className="modal-copy">Create an isolated entity and workspace. You become its initial administrator and can assign another verified account afterward.</p><label className="field"><span>Organization or workspace name</span><input required minLength={2} maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Northstar Operations" /></label><footer className="modal-footer"><span /><button className="button secondary" type="button" onClick={onClose}>Cancel</button><button className="button primary" type="submit" disabled={busy || name.trim().length < 2}><Building2 /> Create workspace</button></footer></form></Modal>;
}

export function AssignAdminDialog({ workspace, busy, onClose, onAssign }: { workspace: PlatformWorkspace; busy: boolean; onClose: () => void; onAssign: (email: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  return <Modal title={`Assign administrator · ${workspace.name}`} eyebrow="Platform administration" onClose={onClose}><form className="modal-form" onSubmit={async (event: FormEvent) => { event.preventDefault(); await onAssign(email.trim().toLowerCase()); }}><p className="modal-copy">The account must already have a verified email. This action creates or updates workspace membership and is audited without exposing document contents.</p><label className="field"><span>Verified account email</span><input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="admin@example.com" /></label><footer className="modal-footer"><span /><button className="button secondary" type="button" onClick={onClose}>Cancel</button><button className="button primary" type="submit" disabled={busy || !email.includes("@")}><UserCog /> Assign administrator</button></footer></form></Modal>;
}

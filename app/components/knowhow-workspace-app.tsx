"use client";

import {
  Activity,
  Archive,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BookOpen,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
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
  LifeBuoy,
  Link2,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Mail,
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
  Children,
  useEffect,
  useCallback,
  isValidElement,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { regenerateMfaRecoveryCodes } from "../../lib/auth-client";
import {
  downloadAuthorizedExport,
  removeWorkspaceLogo,
  knowhowCommand,
  uploadProvisioningLogo,
  uploadWorkspaceLogo,
} from "../../lib/knowhow-client";
import { decryptSecretValue, encryptSecretValue } from "../../lib/crypto";
import type { EncryptedSecretEnvelope } from "../../lib/domain";
import type { NavigationGuard } from "../../lib/navigation-guard";
import {
  ensureKnowHowExtension,
  syncKnowHowExtension,
  type ExtensionCompanion,
} from "../../lib/extension-bridge";
import type {
  AdminAppointment,
  BootstrapResponse,
  Guide,
  GuideSearchResult,
  Invitation,
  OrganizationAdministration,
  OrganizationRole,
  PlatformProvisioningResult,
  PlatformProvisioningRun,
  PlatformWorkspace,
  SupportAccessGrant,
  SupportAccessRequest,
  SupportTicket,
  VaultItem,
  WorkspaceGroup,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceSettings,
} from "../../lib/knowhow-types";
import { WORKSPACE_ROLES } from "../../lib/knowhow-types";
import {
  guideEditorHref,
  guideHref,
  newGuideHref,
  platformHref,
  workspaceHref,
  type AppRoute,
  type GuideRevisionMode,
  type WorkspaceSection,
} from "../../lib/workspace-routes";
import { useTheme } from "./theme-provider";
import {
  GuideEditor,
  ScreenshotAnnotationPreview,
  type GuideEditorPayload,
  type GuideSaveResult,
} from "./guide-editor";
import { AuthorizedMedia } from "./authorized-media";
import { GuideDeleteDialog } from "./guide-delete-dialog";
import { SelectMenu } from "./select-menu";
import { ProductBrand } from "./product-brand";
import { WorkspaceLogo } from "./workspace-logo";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

type View =
  | "Overview"
  | "Guides"
  | "Capture"
  | "Groups"
  | "Members"
  | "Support"
  | "Organization"
  | "Vault"
  | "Settings"
  | "Platform";

type DialogState =
  | null
  | { type: "group"; group: WorkspaceGroup | null }
  | { type: "invite" }
  | { type: "member"; member: WorkspaceMember }
  | { type: "extension" }
  | { type: "account-security" }
  | { type: "platform-create" }
  | { type: "assign-admin"; workspace: PlatformWorkspace }
  | { type: "support-request"; workspace: PlatformWorkspace }
  | { type: "support-decision"; request: SupportAccessRequest }
  | { type: "vault-editor"; item: VaultItem | null }
  | { type: "vault-reveal"; item: VaultItem };

const NAV_ITEMS: Array<{ view: View; icon: typeof LayoutDashboard }> = [
  { view: "Overview", icon: LayoutDashboard },
  { view: "Guides", icon: BookOpen },
  { view: "Capture", icon: Sparkles },
  { view: "Groups", icon: Group },
  { view: "Members", icon: Users },
  { view: "Support", icon: LifeBuoy },
  { view: "Organization", icon: Building2 },
  { view: "Vault", icon: KeyRound },
  { view: "Settings", icon: Settings },
];

const VIEW_TO_SECTION: Record<Exclude<View, "Platform">, WorkspaceSection> = {
  Overview: "overview",
  Guides: "guides",
  Capture: "capture",
  Groups: "groups",
  Members: "members",
  Support: "support",
  Organization: "organization",
  Vault: "vault",
  Settings: "settings",
};

const SECTION_TO_VIEW: Record<WorkspaceSection, Exclude<View, "Platform">> = {
  overview: "Overview",
  guides: "Guides",
  capture: "Capture",
  groups: "Groups",
  members: "Members",
  support: "Support",
  organization: "Organization",
  vault: "Vault",
  settings: "Settings",
};

const ROLE_COPY: Record<WorkspaceRole, string> = {
  administrator: "Workspace settings, people, permissions, and all guides",
  creator: "Create and edit their own draft guides",
  reviewer: "Inspect private drafts and record reviews",
  publisher: "Publish reviewed revisions and archive guides",
  viewer: "Read published guides shared with their audiences",
};

function messageFromError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The operation could not be completed.";
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
  if (value < 1024 * 1024 * 1024)
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
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
  return value
    .replace(/[-_.]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      className={`status-badge status-${status.toLowerCase()}`}
      variant="outline"
    >
      {titleCase(status)}
    </Badge>
  );
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
      <span className="empty-icon">
        <Icon />
      </span>
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className={cn("kh-dialog-content", wide && "kh-dialog-wide")}
      >
        <DialogHeader className="kh-dialog-header">
          <div>
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            <DialogTitle>{title}</DialogTitle>
          </div>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
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
    <Card className={`metric-card metric-${tone}`} size="sm">
      <CardHeader className="metric-card-header">
        <CardDescription>{label}</CardDescription>
        <span className="metric-icon">
          <Icon />
        </span>
      </CardHeader>
      <CardContent className="metric-card-content">
        <strong>{value}</strong>
        <small>{hint}</small>
      </CardContent>
    </Card>
  );
}

function DashboardProgress({
  value,
  label,
  tone = "neutral",
}: {
  value: number;
  label: string;
  tone?: "neutral" | "accent" | "muted";
}) {
  const normalized = Math.max(0, Math.min(100, Math.round(value)));

  return (
    <div
      className={`dashboard-progress dashboard-progress-${tone}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={normalized}
    >
      <span style={{ width: `${normalized}%` }} />
    </div>
  );
}

function GreetingCard({
  name,
  workspaceName,
}: {
  name: string;
  workspaceName: string;
}) {
  const firstName = name.trim().split(/\s+/)[0] || "there";
  const messages = useMemo(
    () => [
      `Let’s keep ${workspaceName} clear and current.`,
      "Ready to make the next step obvious?",
      "A small update can save someone hours.",
      "Keep the team moving with trusted guidance.",
    ],
    [workspaceName],
  );
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMessageIndex((current) => (current + 1) % messages.length);
    }, 9000);
    return () => window.clearInterval(timer);
  }, [messages.length]);

  return (
    <Card className="metric-card greeting-card" size="sm">
      <CardContent className="greeting-card-content">
        <span className="greeting-avatar">{initials(name)}</span>
        <span className="greeting-copy">
          <strong>
            Hi, {firstName} <span aria-hidden="true">👋</span>
          </strong>
          <span className="greeting-message" key={messageIndex}>
            {messages[messageIndex]}
          </span>
        </span>
      </CardContent>
    </Card>
  );
}

function ListPagination({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const start = total ? safePage * pageSize + 1 : 0;
  const end = Math.min(total, (safePage + 1) * pageSize);

  return (
    <div className="list-pagination" aria-label="List pagination">
      <span>
        Showing {start}–{end} of {total}
      </span>
      <div>
        <SelectMenu
          className="display-limit-select"
          value={String(pageSize)}
          onChange={(value) => onPageSizeChange(Number(value))}
          ariaLabel="Items per page"
          options={[5, 10, 25, 50].map((value) => ({
            value: String(value),
            label: `${value} per page`,
          }))}
        />
        <Button
          variant="outline"
          size="icon-sm"
          type="button"
          disabled={safePage === 0}
          onClick={() => onPageChange(safePage - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft />
        </Button>
        <span>
          Page {safePage + 1} of {pageCount}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          type="button"
          disabled={safePage >= pageCount - 1}
          onClick={() => onPageChange(safePage + 1)}
          aria-label="Next page"
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

const ONBOARDING_STEP_COPY: Record<
  NonNullable<BootstrapResponse["activeWorkspace"]>["onboarding"]["steps"][number]["id"],
  { title: string; description: string }
> = {
  workspace_readiness: {
    title: "Confirm workspace readiness",
    description: "Review the pilot data boundary and operating policies.",
  },
  teammate_invitation: {
    title: "Invite a teammate",
    description: "Issue an exact-email, single-use workspace invitation.",
  },
  extension_installation: {
    title: "Install the capture extension",
    description: "Connect the approved Chrome or Edge build to this workspace.",
  },
  first_capture: {
    title: "Complete the first capture",
    description: "Capture one ordinary business process and finish privacy review.",
  },
  first_edit: {
    title: "Edit the draft",
    description: "Make the captured steps clear, owned, and ready for review.",
  },
  first_publication: {
    title: "Publish the first guide",
    description: "Complete review and publish to an explicit audience.",
  },
  teammate_completion: {
    title: "Rehearse teammate completion",
    description: "Have another member open and complete the published guide.",
  },
};

function OnboardingChecklist({
  onboarding,
  busy,
  canCapture,
  canManageAccess,
  onConfirmReadiness,
  onNavigate,
}: {
  onboarding: NonNullable<BootstrapResponse["activeWorkspace"]>["onboarding"];
  busy: boolean;
  canCapture: boolean;
  canManageAccess: boolean;
  onConfirmReadiness: () => Promise<void>;
  onNavigate: (view: View) => void;
}) {
  const [ordinaryDataOnly, setOrdinaryDataOnly] = useState(false);
  const [policiesReviewed, setPoliciesReviewed] = useState(false);
  if (onboarding.completedAt) return null;
  const current = onboarding.steps.find((step) => !step.completed);
  const completed = onboarding.steps.filter((step) => step.completed).length;

  const nextAction = () => {
    if (!current) return;
    if (current.id === "teammate_invitation") {
      if (canManageAccess) onNavigate("Members");
      return;
    }
    if (
      current.id === "extension_installation" ||
      current.id === "first_capture"
    ) {
      if (canCapture) onNavigate("Capture");
      return;
    }
    onNavigate("Guides");
  };

  return (
    <Card className="onboarding-checklist">
      <CardHeader className="dashboard-card-header">
        <div>
          <CardTitle>Pilot activation</CardTitle>
          <CardDescription>
            Resume the real workflow until another teammate completes it.
          </CardDescription>
        </div>
        <Badge variant="outline">
          {completed} of {onboarding.steps.length}
        </Badge>
      </CardHeader>
      <CardContent className="onboarding-checklist-content">
        <ol>
          {onboarding.steps.map((step, index) => (
            <li
              key={step.id}
              className={step.completed ? "complete" : current?.id === step.id ? "current" : ""}
            >
              <span>{step.completed ? <Check /> : index + 1}</span>
              <div>
                <strong>{ONBOARDING_STEP_COPY[step.id].title}</strong>
                <small>{ONBOARDING_STEP_COPY[step.id].description}</small>
              </div>
            </li>
          ))}
        </ol>
        {current?.id === "workspace_readiness" ? (
          <div className="onboarding-readiness">
            <label className="choice-row">
              <input
                type="checkbox"
                checked={ordinaryDataOnly}
                onChange={(event) => setOrdinaryDataOnly(event.target.checked)}
              />
              <span>
                <strong>Ordinary business-process data only</strong>
                <small>No credentials, payments, health data, national IDs, or sensitive data.</small>
              </span>
            </label>
            <label className="choice-row">
              <input
                type="checkbox"
                checked={policiesReviewed}
                onChange={(event) => setPoliciesReviewed(event.target.checked)}
              />
              <span>
                <strong>Pilot policies reviewed</strong>
                <small>The workspace owner has reviewed the agreed terms and capture boundaries.</small>
              </span>
            </label>
            <Button
              size="sm"
              type="button"
              disabled={busy || !ordinaryDataOnly || !policiesReviewed}
              onClick={() => void onConfirmReadiness()}
            >
              <ShieldCheck /> Confirm readiness
            </Button>
          </div>
        ) : current ? (
          <div className="onboarding-next-action">
            <span>
              <strong>Next: {ONBOARDING_STEP_COPY[current.id].title}</strong>
              <small>
                {current.id === "teammate_invitation" && !canManageAccess
                  ? "Ask a workspace administrator to invite the first teammate."
                  : current.id === "first_capture" && !canCapture
                    ? "Ask a creator or workspace administrator to complete the first capture."
                    : "KnowHow records this milestone automatically."}
              </small>
            </span>
            <Button
              variant="outline"
              size="sm"
              type="button"
              disabled={
                busy ||
                (current.id === "teammate_invitation" && !canManageAccess) ||
                (["extension_installation", "first_capture"].includes(current.id) &&
                  !canCapture)
              }
              onClick={nextAction}
            >
              Continue <ArrowRight />
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function OverviewView({
  data,
  viewerName,
  canCreate,
  canCapture,
  canManageAccess,
  busy,
  onNewGuide,
  onOpenGuide,
  onNavigate,
  onConfirmReadiness,
}: {
  data: NonNullable<BootstrapResponse["activeWorkspace"]>;
  viewerName: string;
  canCreate: boolean;
  canCapture: boolean;
  canManageAccess: boolean;
  busy: boolean;
  onNewGuide: () => void;
  onOpenGuide: (guide: Guide) => void;
  onNavigate: (view: View) => void;
  onConfirmReadiness: () => Promise<void>;
}) {
  const { metrics, guides, groups, members } = data;
  const recent = [...guides]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);
  const attention = [...guides]
    .filter((guide) => guide.status === "review" || guide.status === "draft")
    .sort((a, b) => {
      if (a.status === b.status) return b.updatedAt.localeCompare(a.updatedAt);
      return a.status === "review" ? -1 : 1;
    })
    .slice(0, 4);
  const activeMembers = members.filter(
    (item) => item.status === "active",
  ).length;
  const restrictedGuides = guides.filter((item) => item.restricted).length;
  const lifecycleTotal = metrics.drafts + metrics.reviews + metrics.published;
  const safeLifecycleTotal = Math.max(1, lifecycleTotal);
  const publishedStop = (metrics.published / safeLifecycleTotal) * 100;
  const reviewStop =
    publishedStop + (metrics.reviews / safeLifecycleTotal) * 100;
  const lifecycleBackground = `conic-gradient(var(--foreground) 0 ${publishedStop}%, var(--brand) ${publishedStop}% ${reviewStop}%, var(--chart-muted) ${reviewStop}% 100%)`;
  const activityValues = [
    {
      label: "Views",
      value: metrics.views,
      icon: Eye,
      tone: "neutral" as const,
    },
    {
      label: "Completions",
      value: metrics.completions,
      icon: CheckCircle2,
      tone: "accent" as const,
    },
    {
      label: "Captures",
      value: metrics.captures,
      icon: Sparkles,
      tone: "muted" as const,
    },
    {
      label: "Exports",
      value: metrics.exports,
      icon: Download,
      tone: "muted" as const,
    },
  ];
  const maxActivity = Math.max(1, ...activityValues.map((item) => item.value));
  const completionRate =
    metrics.views > 0
      ? Math.min(100, (metrics.completions / metrics.views) * 100)
      : 0;
  const activeMemberRate =
    members.length > 0 ? (activeMembers / members.length) * 100 : 0;
  const audienceAssigned = guides.filter((guide) => {
    const revision = guide.workingRevision ?? guide.publishedRevision;
    return Boolean(revision?.audiences.length);
  }).length;
  const audienceCoverage =
    guides.length > 0 ? (audienceAssigned / guides.length) * 100 : 0;
  const visibleMembers = members
    .filter((item) => item.status === "active")
    .slice(0, 4);

  return (
    <div className="workspace-overview">
      <section className="overview-page-header">
        <div className="overview-heading">
          <h1>Dashboard</h1>
          <p>Monitor knowledge, reviews, engagement, and audience coverage.</p>
        </div>
        <div className="overview-header-actions">
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={!canCapture}
            onClick={() => onNavigate("Capture")}
          >
            <Sparkles /> Capture workflow
          </Button>
          <Button
            size="sm"
            type="button"
            disabled={!canCreate}
            onClick={onNewGuide}
          >
            <Plus /> New guide
          </Button>
        </div>
      </section>

      <OnboardingChecklist
        onboarding={data.onboarding}
        busy={busy}
        canCapture={canCapture}
        canManageAccess={canManageAccess}
        onConfirmReadiness={onConfirmReadiness}
        onNavigate={onNavigate}
      />

      <section className="metric-grid overview-metric-grid">
        <GreetingCard name={viewerName} workspaceName={data.workspace.name} />
        <MetricCard
          label="Published guides"
          value={metrics.published}
          hint="Available to assigned audiences"
          icon={Globe2}
          tone="accent"
        />
        <MetricCard
          label="Review queue"
          value={metrics.reviews}
          hint={`${metrics.drafts} private drafts in progress`}
          icon={ClipboardCheck}
          tone="warning"
        />
        <MetricCard
          label="Total engagement"
          value={metrics.views + metrics.completions}
          hint={`${metrics.completions} guide completions`}
          icon={BarChart3}
        />
      </section>

      <section className="dashboard-insight-grid">
        <Card className="lifecycle-card">
          <CardHeader className="dashboard-card-header">
            <div>
              <CardTitle>Knowledge lifecycle</CardTitle>
              <CardDescription>
                Current distribution across every release stage.
              </CardDescription>
            </div>
            <Badge variant="outline">{lifecycleTotal} total</Badge>
          </CardHeader>
          <CardContent className="lifecycle-card-content">
            <div
              className="lifecycle-donut"
              style={{ background: lifecycleBackground }}
              aria-label={`${metrics.published} published, ${metrics.reviews} in review, ${metrics.drafts} drafts`}
            >
              <div>
                <strong>{lifecycleTotal}</strong>
                <span>guides</span>
              </div>
            </div>
            <div className="lifecycle-legend">
              <button type="button" onClick={() => onNavigate("Guides")}>
                <i className="lifecycle-published" />
                <span>
                  Published<small>Ready for audiences</small>
                </span>
                <strong>{metrics.published}</strong>
              </button>
              <button type="button" onClick={() => onNavigate("Guides")}>
                <i className="lifecycle-review" />
                <span>
                  In review<small>Waiting on a decision</small>
                </span>
                <strong>{metrics.reviews}</strong>
              </button>
              <button type="button" onClick={() => onNavigate("Guides")}>
                <i className="lifecycle-draft" />
                <span>
                  Drafts<small>Work still in progress</small>
                </span>
                <strong>{metrics.drafts}</strong>
              </button>
            </div>
          </CardContent>
        </Card>

        <Card className="engagement-card">
          <CardHeader className="dashboard-card-header">
            <div>
              <CardTitle>Workspace activity</CardTitle>
              <CardDescription>
                Real usage totals from capture through completion.
              </CardDescription>
            </div>
            <div className="engagement-summary">
              <strong>{metrics.views + metrics.completions}</strong>
              <span>interactions</span>
            </div>
          </CardHeader>
          <CardContent className="engagement-bars">
            {activityValues.map(({ label, value, icon: Icon, tone }) => (
              <div className="engagement-bar-row" key={label}>
                <span className="engagement-bar-label">
                  <Icon />
                  <span>{label}</span>
                </span>
                <DashboardProgress
                  value={(value / maxActivity) * 100}
                  label={`${label}: ${value}`}
                  tone={tone}
                />
                <strong>{value}</strong>
              </div>
            ))}
            <div className="completion-rate">
              <div>
                <span>Completion rate</span>
                <strong>{Math.round(completionRate)}%</strong>
              </div>
              <DashboardProgress
                value={completionRate}
                label="Guide completion rate"
                tone="accent"
              />
            </div>
          </CardContent>
        </Card>

        <Card className="review-queue-card">
          <CardHeader className="dashboard-card-header">
            <div>
              <CardTitle>Review queue</CardTitle>
              <CardDescription>
                Items that need the next action.
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              onClick={() => onNavigate("Guides")}
              aria-label="Open guide library"
            >
              <ArrowRight />
            </Button>
          </CardHeader>
          <CardContent className="review-queue-content">
            {attention.length ? (
              attention.map((guide) => {
                const revision =
                  guide.workingRevision ?? guide.publishedRevision;
                const isReview = guide.status === "review";
                return (
                  <button
                    className="review-queue-row"
                    type="button"
                    key={guide.id}
                    onClick={() => onOpenGuide(guide)}
                  >
                    <span
                      className={cn(
                        "review-state-icon",
                        isReview && "is-review",
                      )}
                    >
                      {isReview ? <ClipboardCheck /> : <FileText />}
                    </span>
                    <span>
                      <strong>{revision?.title ?? guide.title}</strong>
                      <small>
                        {isReview ? "Decision required" : "Draft in progress"}
                      </small>
                    </span>
                    <ArrowRight />
                  </button>
                );
              })
            ) : (
              <div className="queue-clear-state">
                <CheckCircle2 />
                <strong>Queue is clear</strong>
                <span>No drafts or reviews need attention.</span>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <div className="dashboard-work-grid">
        <Card className="dashboard-guide-queue">
          <CardHeader className="dashboard-card-header">
            <div>
              <CardTitle>Recently changed guides</CardTitle>
              <CardDescription>
                Continue where the workspace last left off.
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => onNavigate("Guides")}
            >
              View library <ArrowRight />
            </Button>
          </CardHeader>
          <CardContent className="dashboard-queue-content">
            {recent.length ? (
              <div className="dashboard-queue-list">
                {recent.map((guide) => {
                  const revision =
                    guide.workingRevision ?? guide.publishedRevision;
                  return (
                    <button
                      className="dashboard-queue-row"
                      type="button"
                      key={guide.id}
                      onClick={() => onOpenGuide(guide)}
                    >
                      <span className="queue-guide-icon">
                        <BookOpen />
                      </span>
                      <span className="queue-guide-main">
                        <strong>{revision?.title ?? guide.title}</strong>
                        <small>
                          {revision?.category || "Uncategorized"} · Updated{" "}
                          {formatDate(guide.updatedAt)}
                        </small>
                      </span>
                      <StatusBadge status={guide.status} />
                      {guide.restricted ? (
                        <LockKeyhole
                          className="restricted-icon"
                          aria-label="Restricted"
                        />
                      ) : null}
                      <ArrowRight />
                    </button>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                icon={BookOpen}
                title="No guides yet"
                description="Create the first private draft for this workspace."
                action={
                  canCreate ? (
                    <Button onClick={onNewGuide}>
                      <Plus /> Create guide
                    </Button>
                  ) : undefined
                }
              />
            )}
          </CardContent>
        </Card>

        <Card className="access-health-card">
          <CardHeader className="dashboard-card-header">
            <div>
              <CardTitle>Audience coverage</CardTitle>
              <CardDescription>
                People, groups, and publishing boundaries.
              </CardDescription>
            </div>
            <span className="access-shield">
              <ShieldCheck />
            </span>
          </CardHeader>
          <CardContent className="access-health-content">
            <div className="audience-people-row">
              <AvatarGroup>
                {visibleMembers.map((member) => (
                  <Avatar size="sm" key={member.id}>
                    <AvatarFallback>
                      {initials(member.name, member.email)}
                    </AvatarFallback>
                  </Avatar>
                ))}
                {activeMembers > visibleMembers.length ? (
                  <AvatarGroupCount>
                    +{activeMembers - visibleMembers.length}
                  </AvatarGroupCount>
                ) : null}
              </AvatarGroup>
              <div>
                <strong>{activeMembers} active people</strong>
                <span>across {groups.length} audience groups</span>
              </div>
            </div>
            <div className="coverage-metric">
              <div>
                <span>Active membership</span>
                <strong>{Math.round(activeMemberRate)}%</strong>
              </div>
              <DashboardProgress
                value={activeMemberRate}
                label="Active workspace membership"
              />
            </div>
            <div className="coverage-metric">
              <div>
                <span>Audience assignment</span>
                <strong>{Math.round(audienceCoverage)}%</strong>
              </div>
              <DashboardProgress
                value={audienceCoverage}
                label="Guides assigned to an audience"
                tone="accent"
              />
            </div>
            <div className="access-health-stats">
              <button
                type="button"
                disabled={!canManageAccess}
                onClick={() => onNavigate("Members")}
              >
                <span>
                  <Users /> Members
                </span>
                <strong>{members.length}</strong>
              </button>
              <button
                type="button"
                disabled={!canManageAccess}
                onClick={() => onNavigate("Groups")}
              >
                <span>
                  <Group /> Groups
                </span>
                <strong>{groups.length}</strong>
              </button>
              <button type="button" onClick={() => onNavigate("Guides")}>
                <span>
                  <LockKeyhole /> Restricted
                </span>
                <strong>{restrictedGuides}</strong>
              </button>
            </div>
            <p className="access-health-note">
              <Shield /> Roles grant actions. Audiences control delivery.
            </p>
          </CardContent>
        </Card>
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
  onAction: (
    action: string,
    payload: unknown,
    message: string,
  ) => Promise<void>;
  busy: boolean;
  canCreate: boolean;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [pageSize, setPageSize] = useState(5);
  const [page, setPage] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<Guide | null>(null);
  const filtered = guides.filter((guide) => {
    const revision = guide.workingRevision ?? guide.publishedRevision;
    const text =
      `${guide.title} ${revision?.summary ?? ""} ${revision?.tags.join(" ") ?? ""}`.toLowerCase();
    return (
      text.includes(query.toLowerCase()) &&
      (status === "all" || guide.status === status)
    );
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visibleGuides = filtered.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );

  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Knowledge library</p>
          <h1>Guides</h1>
          <p>
            Draft privately, review with context, and publish without
            interrupting the live revision.
          </p>
        </div>
        <Button type="button" disabled={!canCreate} onClick={onNew}>
          <Plus /> New guide
        </Button>
      </div>
      <section className="card table-card">
        <div className="filter-bar">
          <label className="search-field">
            <Search />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
              placeholder="Search guides"
            />
          </label>
          <SelectMenu
            className="filter-select"
            leading={<Filter />}
            value={status}
            onChange={(value) => {
              setStatus(value);
              setPage(0);
            }}
            ariaLabel="Filter guides by lifecycle state"
            options={[
              { value: "all", label: "All lifecycle states" },
              { value: "draft", label: "Draft" },
              { value: "review", label: "In review" },
              { value: "published", label: "Published" },
              { value: "archived", label: "Archived" },
            ]}
          />
          <span className="result-count">
            {filtered.length} {filtered.length === 1 ? "guide" : "guides"}
          </span>
        </div>
        {filtered.length ? (
          <div className="guide-table">
            {visibleGuides.map((guide) => {
              const revision = guide.workingRevision ?? guide.publishedRevision;
              const live = guide.publishedRevision;
              return (
                <article className="guide-card" key={guide.id}>
                  <button
                    className="guide-card-main"
                    type="button"
                    onClick={() => onOpen(guide)}
                  >
                    <span className="guide-icon large">
                      <BookOpen />
                    </span>
                    <span className="guide-content">
                      <span className="guide-title-line">
                        <strong>{revision?.title ?? guide.title}</strong>
                        {guide.restricted ? (
                          <span className="restricted-label">
                            <LockKeyhole /> Restricted
                          </span>
                        ) : (
                          <span className="workspace-label">
                            <Globe2 /> Workspace
                          </span>
                        )}
                      </span>
                      <span className="guide-summary">
                        {revision?.summary || "No description yet."}
                      </span>
                      <span className="guide-meta">
                        {revision?.category || "Uncategorized"} ·{" "}
                        {revision?.steps.length ?? 0} blocks · Updated{" "}
                        {formatDate(guide.updatedAt)}
                      </span>
                    </span>
                  </button>
                  <div className="guide-state-column">
                    <StatusBadge status={guide.status} />
                    {guide.workingRevision && live ? (
                      <small>v{live.number} remains live</small>
                    ) : revision ? (
                      <small>Revision {revision.number}</small>
                    ) : null}
                  </div>
                  <div className="guide-actions">
                    {guide.canEdit && guide.status !== "archived" ? (
                      <button
                        className="button ghost small"
                        type="button"
                        onClick={() => onEdit(guide)}
                      >
                        Edit
                      </button>
                    ) : null}
                    {guide.canReview && guide.status === "review" ? (
                      <>
                        <button
                          className="button secondary small"
                          disabled={busy}
                          type="button"
                          onClick={() => {
                            if (
                              window.confirm(
                                "Approve this revision for publication?",
                              )
                            )
                              void onAction(
                                "reviewGuide",
                                { guideId: guide.id, decision: "approved" },
                                "Review approved",
                              ).catch(() => undefined);
                          }}
                        >
                          Approve
                        </button>
                        <button
                          className="button ghost small"
                          disabled={busy}
                          type="button"
                          onClick={() => {
                            if (
                              window.confirm(
                                "Return this revision to its author for changes?",
                              )
                            )
                              void onAction(
                                "reviewGuide",
                                {
                                  guideId: guide.id,
                                  decision: "changes_requested",
                                },
                                "Changes requested",
                              ).catch(() => undefined);
                          }}
                        >
                          Request changes
                        </button>
                      </>
                    ) : null}
                    {guide.canPublish && guide.status === "review" ? (
                      <button
                        className="button primary small"
                        disabled={busy}
                        type="button"
                        onClick={() =>
                          onAction(
                            "publishGuide",
                            { guideId: guide.id },
                            "New revision published",
                          )
                        }
                      >
                        Publish
                      </button>
                    ) : null}
                    {guide.canPublish && guide.status !== "archived" ? (
                      <button
                        className="icon-button"
                        title="Archive guide"
                        disabled={busy}
                        type="button"
                        onClick={() =>
                          onAction(
                            "archiveGuide",
                            { guideId: guide.id },
                            "Guide archived",
                          )
                        }
                      >
                        <Archive />
                      </button>
                    ) : null}
                    {guide.canDelete ? (
                      <button
                        className="button ghost small danger-button"
                        disabled={busy}
                        type="button"
                        onClick={() => setDeleteTarget(guide)}
                      >
                        <Trash2 /> Delete
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={Search}
            title="No matching guides"
            description="Try another search or lifecycle filter."
          />
        )}
        {filtered.length ? (
          <ListPagination
            total={filtered.length}
            page={safePage}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(value) => {
              setPageSize(value);
              setPage(0);
            }}
          />
        ) : null}
      </section>
      {deleteTarget ? (
        <GuideDeleteDialog
          title={
            deleteTarget.workingRevision?.title ??
            deleteTarget.publishedRevision?.title ??
            deleteTarget.title
          }
          busy={busy}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => {
            await onAction(
              "deleteGuide",
              { guideId: deleteTarget.id },
              "Guide deleted",
            );
            setDeleteTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}

function GuideViewer({
  guide,
  workspaceId,
  workspaceName,
  logoKey,
  accentColor,
  clickTargetColor,
  initialRevision,
  liveUrl,
  canExport,
  canRestore,
  busy,
  onClose,
  onEdit,
  onDelete,
  onRevisionChange,
  onExport,
  onRestore,
  onPublishedViewed,
  onComplete,
}: {
  guide: Guide;
  workspaceId: string;
  workspaceName: string;
  logoKey: string | null;
  accentColor: string;
  clickTargetColor: string;
  initialRevision: GuideRevisionMode;
  liveUrl: string;
  canExport: boolean;
  canRestore: boolean;
  busy: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDelete?: () => Promise<void>;
  onRevisionChange: (revision: GuideRevisionMode) => void;
  onExport: (format: "pdf" | "html" | "markdown") => void;
  onRestore: (revisionId: string) => void;
  onPublishedViewed: () => void;
  onComplete: () => void;
}) {
  const [deletePromptOpen, setDeletePromptOpen] = useState(false);
  const preferredRevision: GuideRevisionMode =
    initialRevision === "working" && guide.workingRevision
      ? "working"
      : guide.publishedRevision
        ? "published"
        : "working";
  const revisionMode = preferredRevision;
  const revision =
    revisionMode === "working"
      ? guide.workingRevision
      : guide.publishedRevision;

  if (!revision) return null;

  return (
    <main className="guide-reader-page" aria-labelledby="guide-reader-title">
      <header className="guide-reader-header">
        <div className="guide-reader-header-inner">
          <div className="reader-nav-context">
            <button
              className="button ghost small"
              type="button"
              onClick={onClose}
            >
              <ArrowLeft /> Guides
            </button>
            <span className="reader-header-divider" />
            <span className="reader-workspace">
              <WorkspaceLogo
                workspaceId={workspaceId}
                workspaceName={workspaceName}
                logoKey={logoKey}
                size="sm"
              />
              <span>
                <strong>{workspaceName}</strong>
                <small>Revision {revision.number}</small>
              </span>
            </span>
          </div>
          <div className="viewer-toolbar">
            <div className="revision-toggle">
              {guide.workingRevision ? (
                <button
                  type="button"
                  className={revisionMode === "working" ? "active" : ""}
                  onClick={() => onRevisionChange("working")}
                >
                  Working {guide.workingRevision.status}
                </button>
              ) : null}
              {guide.publishedRevision ? (
                <button
                  type="button"
                  className={revisionMode === "published" ? "active" : ""}
                  onClick={() => {
                    onRevisionChange("published");
                    onPublishedViewed();
                  }}
                >
                  Live v{guide.publishedRevision.number}
                </button>
              ) : null}
            </div>
            <div className="viewer-actions">
              {guide.publishedRevision ? (
                <button
                  className="button ghost small"
                  type="button"
                  onClick={async () => navigator.clipboard.writeText(liveUrl)}
                >
                  <Link2 /> Copy live link
                </button>
              ) : null}
              {canExport && guide.publishedRevision ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className="button secondary small"
                    type="button"
                  >
                    <Download /> Export
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="export-menu">
                    <DropdownMenuItem onClick={() => onExport("pdf")}>
                      PDF
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onExport("html")}>
                      HTML
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onExport("markdown")}>
                      Markdown
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {revisionMode === "published" && guide.publishedRevision ? (
                <button
                  className="button secondary small"
                  type="button"
                  disabled={busy}
                  onClick={onComplete}
                >
                  <CheckCircle2 /> Mark complete
                </button>
              ) : null}
              {guide.canEdit ? (
                <button
                  className="button primary small"
                  type="button"
                  onClick={onEdit}
                >
                  Edit draft
                </button>
              ) : null}
              {guide.canDelete && onDelete ? (
                <button
                  className="button ghost small danger-button"
                  type="button"
                  disabled={busy}
                  onClick={() => setDeletePromptOpen(true)}
                >
                  <Trash2 /> Delete
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </header>
      <div className="guide-viewer">
        <header className="document-header card">
          <div className="document-meta">
            <StatusBadge status={revision.status} />
            {guide.restricted ? (
              <span>
                <LockKeyhole /> Restricted audience
              </span>
            ) : (
              <span>
                <Globe2 /> Entire workspace
              </span>
            )}
          </div>
          <h1 id="guide-reader-title">{revision.title}</h1>
          <p>{revision.summary}</p>
          <div className="document-facts">
            <span>{revision.category || "Uncategorized"}</span>
            <span>{revision.steps.length} blocks</span>
            <span>By {revision.authorName}</span>
            {revision.publishedAt ? (
              <span>Published {formatDate(revision.publishedAt)}</span>
            ) : null}
          </div>
        </header>
        <div className="document-steps">
          {revision.steps.map((step, index) => (
            <section
              className={`document-step document-${step.kind}`}
              key={step.id}
            >
              {step.kind === "action" ? (
                <span className="document-step-number">{index + 1}</span>
              ) : null}
              <div>
                <h2>{step.title}</h2>
                {step.screenshotMediaId ? (
                  <AuthorizedMedia
                    workspaceId={workspaceId}
                    mediaId={step.screenshotMediaId}
                    alt={`Redacted screenshot for ${step.title}`}
                    crop={step.crop}
                    overlay={
                      <ScreenshotAnnotationPreview
                        step={step}
                        accentColor={accentColor}
                        clickTargetColor={clickTargetColor}
                        showCropOutline={false}
                      />
                    }
                  />
                ) : null}
              </div>
            </section>
          ))}
        </div>
        {guide.revisionHistory?.length ? (
          <section className="revision-history">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Governance trail</p>
                <h2>Revision history</h2>
              </div>
              <History />
            </div>
            {guide.revisionHistory.map((item) => (
              <div className="history-row" key={item.id}>
                <span className="history-number">v{item.number}</span>
                <span>
                  <strong>{titleCase(item.status)}</strong>
                  <small>
                    Created by {item.authorName} ·{" "}
                    {formatDate(item.createdAt, true)}
                  </small>
                </span>
                {item.reviewedAt ? (
                  <span className="history-check">
                    <Check /> Reviewed
                  </span>
                ) : null}
                {item.publishedAt ? (
                  <span className="history-check">
                    <Globe2 /> {formatDate(item.publishedAt)}
                  </span>
                ) : null}
                {canRestore && !guide.workingRevision ? (
                  <button
                    className="button ghost small"
                    disabled={busy}
                    type="button"
                    onClick={() => onRestore(item.id)}
                  >
                    <RotateCcw /> Restore as draft
                  </button>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}
      </div>
      {deletePromptOpen && onDelete ? (
        <GuideDeleteDialog
          title={revision.title}
          busy={busy}
          onCancel={() => setDeletePromptOpen(false)}
          onConfirm={onDelete}
        />
      ) : null}
    </main>
  );
}

function CaptureView({
  onOpenExtension,
  canCapture,
}: {
  onOpenExtension: () => void;
  canCapture: boolean;
}) {
  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Chrome & Edge</p>
          <h1>Capture a workflow</h1>
          <p>
            Record clicks and navigation, redact locally, then send an editable
            private draft to KnowHow.
          </p>
        </div>
        <Button type="button" disabled={!canCapture} onClick={onOpenExtension}>
          <Laptop /> Pair extension
        </Button>
      </div>
      <section className="capture-hero card">
        <div className="capture-demo">
          <div className="fake-browser">
            <div className="fake-browser-top">
              <span />
              <span />
              <span />
              <div>portal.example.com</div>
            </div>
            <div className="fake-browser-body">
              <span className="recording-pill">
                <span /> Recording · portal.example.com
              </span>
              <div className="capture-target" />
              <div className="blur-block blur-one" />
              <div className="blur-block blur-two" />
            </div>
          </div>
          <div className="capture-controls">
            <span>
              <Pause /> Pause means zero new events or screenshots
            </span>
            <span>
              <ShieldCheck /> Redaction happens before upload
            </span>
          </div>
        </div>
        <div className="capture-copy">
          <p className="eyebrow">A safer recorder</p>
          <h2>Nothing leaves the browser until privacy review.</h2>
          <p>
            KnowHow captures click context and rasterized screenshots without
            passwords, clipboard contents, raw keystrokes, incognito sessions,
            or password-manager pages.
          </p>
          <ol>
            <li>
              <span>1</span>
              <div>
                <strong>Start with an explicit scope</strong>
                <p>
                  The indicator always shows the current host and recording
                  state.
                </p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Pause instantly</strong>
                <p>
                  Queued events and in-flight screenshots are cancelled when
                  paused.
                </p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Review every image locally</strong>
                <p>
                  Blur emails, form fields, number categories, similar elements,
                  or whole regions.
                </p>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <strong>Send a private draft</strong>
                <p>
                  The same governed editor handles captured and manual guides.
                </p>
              </div>
            </li>
          </ol>
        </div>
      </section>
      <section className="privacy-grid">
        {[
          {
            icon: LockKeyhole,
            title: "Always excluded",
            copy: "Passwords, clipboard contents, raw keys, incognito, and password managers.",
          },
          {
            icon: Shield,
            title: "Local Smart Blur",
            copy: "Emails, selected form fields, configured number categories, and manual regions.",
          },
          {
            icon: Eye,
            title: "Human privacy gate",
            copy: "Common-name and long-text hints assist reviewers but never claim guaranteed protection.",
          },
        ].map(({ icon: Icon, title, copy }) => (
          <article className="card privacy-card" key={title}>
            <Icon />
            <h3>{title}</h3>
            <p>{copy}</p>
          </article>
        ))}
      </section>
    </div>
  );
}

function GroupsView({
  groups,
  busy,
  onNew,
  onEdit,
}: {
  groups: WorkspaceGroup[];
  busy: boolean;
  onNew: () => void;
  onEdit: (group: WorkspaceGroup) => void;
}) {
  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Content audiences</p>
          <h1>Groups</h1>
          <p>
            People can belong to several groups. Group membership never changes
            their workspace role.
          </p>
        </div>
        <Button type="button" disabled={busy} onClick={onNew}>
          <Plus /> New group
        </Button>
      </div>
      <section className="group-directory-card">
        {groups.length ? (
          <div className="group-grid">
            {groups.map((group) => (
              <button
                className="group-card"
                type="button"
                disabled={busy || group.kind === "all_members"}
                key={group.id}
                onClick={() => onEdit(group)}
              >
                <span
                  className={`group-icon${group.sensitive ? " sensitive" : ""}`}
                >
                  {group.sensitive ? <LockKeyhole /> : <Group />}
                </span>
                <span>
                  <strong>{group.name}</strong>
                  <small>
                    {group.kind === "all_members"
                      ? "Built-in audience for publishing a guide to every active workspace member."
                      : group.description || "No description"}
                  </small>
                </span>
                <span className="group-count">
                  <Users /> {group.memberCount}
                </span>
                {group.kind === "all_members" ? (
                  <ShieldCheck />
                ) : (
                  <ArrowRight />
                )}
              </button>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Group}
            title="No audience groups"
            description="Create Finance, Security, All Employees, or another audience."
            action={
              !busy ? (
                <Button onClick={onNew}>
                  <Plus /> New group
                </Button>
              ) : undefined
            }
          />
        )}
      </section>
    </div>
  );
}

function GroupDialog({
  group,
  members,
  busy,
  onClose,
  onSave,
  onDelete,
}: {
  group: WorkspaceGroup | null;
  members: WorkspaceMember[];
  busy: boolean;
  onClose: () => void;
  onSave: (payload: {
    id?: string;
    name: string;
    description: string;
    sensitive: boolean;
    memberIds: string[];
  }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [sensitive, setSensitive] = useState(group?.sensitive ?? false);
  const [memberIds, setMemberIds] = useState(group?.memberIds ?? []);
  return (
    <Modal
      title={group ? `Edit ${group.name}` : "Create audience group"}
      eyebrow="Workspace sharing"
      onClose={onClose}
    >
      <form
        className="modal-form"
        onSubmit={async (event) => {
          event.preventDefault();
          await onSave({
            id: group?.id,
            name: name.trim(),
            description: description.trim(),
            sensitive,
            memberIds,
          });
        }}
      >
        <label className="field">
          <span>Group name</span>
          <input
            required
            minLength={2}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Finance"
          />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="People who handle billing and financial operations"
          />
        </label>
        <label className="choice-row emphasized">
          <input
            type="checkbox"
            checked={sensitive}
            onChange={(event) => setSensitive(event.target.checked)}
          />
          <span>
            <strong>Sensitive group</strong>
            <small>
              Membership can only be assigned by an administrator, never by a
              generic invite.
            </small>
          </span>
        </label>
        <div className="member-picker">
          <span className="field-label">Members</span>
          {members
            .filter((member) => member.status === "active")
            .map((member) => (
              <label className="choice-row" key={member.id}>
                <input
                  type="checkbox"
                  checked={memberIds.includes(member.userId)}
                  onChange={() =>
                    setMemberIds((items) =>
                      items.includes(member.userId)
                        ? items.filter((id) => id !== member.userId)
                        : [...items, member.userId],
                    )
                  }
                />
                <span className="member-choice-avatar">
                  {initials(member.name, member.email)}
                </span>
                <span>
                  <strong>{member.name || member.email}</strong>
                  <small>{member.email}</small>
                </span>
              </label>
            ))}
        </div>
        <footer className="modal-footer">
          {group ? (
            <button
              className="button danger-button"
              type="button"
              disabled={busy}
              onClick={() => onDelete(group.id)}
            >
              <Trash2 /> Delete
            </button>
          ) : (
            <span />
          )}
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || name.trim().length < 2}
          >
            {busy ? <LoaderCircle className="spin" /> : <Check />} Save
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function MembersView({
  members,
  invitations,
  supportRequests,
  supportGrants,
  busy,
  onInvite,
  onEdit,
  onRevoke,
  onResolveSupport,
  onRevokeSupport,
}: {
  members: WorkspaceMember[];
  invitations: Invitation[];
  supportRequests: SupportAccessRequest[];
  supportGrants: SupportAccessGrant[];
  busy: boolean;
  onInvite: () => void;
  onEdit: (member: WorkspaceMember) => void;
  onRevoke: (id: string) => void;
  onResolveSupport: (request: SupportAccessRequest) => void;
  onRevokeSupport: (grant: SupportAccessGrant) => void;
}) {
  const pendingSupport = supportRequests.filter(
    (item) => item.status === "pending",
  );
  const [renderedAt] = useState(() => Date.now());
  const [memberQuery, setMemberQuery] = useState("");
  const visibleMembers = useMemo(() => {
    const query = memberQuery.trim().toLocaleLowerCase();
    if (!query) return members;
    return members.filter((member) =>
      `${member.name ?? ""} ${member.email} ${member.roles.join(" ")}`
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [memberQuery, members]);
  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Workspace access</p>
          <h1>Members & invitations</h1>
          <p>
            Roles grant actions. Groups decide which published guides each
            person receives.
          </p>
        </div>
        <button className="button primary" disabled={busy} onClick={onInvite}>
          <UserPlus /> Invite teammate
        </button>
      </div>
      {pendingSupport.length ? (
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Needs a decision</p>
              <h2>Temporary support requests</h2>
            </div>
            <CircleAlert />
          </div>
          {pendingSupport.map((request) => (
            <div className="member-row" key={request.id}>
              <span className="avatar">
                {initials(request.requesterName, request.requesterEmail)}
              </span>
              <span className="member-main">
                <strong>
                  {request.requesterName || request.requesterEmail}
                </strong>
                <small>
                  {request.requesterEmail} · requests{" "}
                  {titleCase(request.requestedRole)} access for{" "}
                  {request.requestedDurationHours}{" "}
                  {request.requestedDurationHours === 1 ? "hour" : "hours"}
                </small>
                <small className="support-reason">{request.reason}</small>
              </span>
              <button
                className="button ghost small"
                disabled={busy}
                onClick={() => onResolveSupport(request)}
              >
                <ShieldCheck /> Review
              </button>
            </div>
          ))}
        </section>
      ) : null}
      <section className="card table-card members-directory">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">People</p>
            <h2>
              {visibleMembers.length === members.length
                ? `${members.length} workspace members`
                : `${visibleMembers.length} of ${members.length} members`}
            </h2>
          </div>
          <label className="search-field member-search">
            <Search />
            <input
              value={memberQuery}
              onChange={(event) => setMemberQuery(event.target.value)}
              placeholder="Search members"
              aria-label="Search workspace members"
            />
          </label>
        </div>
        <div className="member-table">
          {visibleMembers.length ? (
            visibleMembers.map((member) => (
              <button
                className="member-row clickable"
                disabled={busy}
                type="button"
                key={member.id}
                onClick={() => onEdit(member)}
              >
                <span className="avatar">
                  {initials(member.name, member.email)}
                </span>
                <span className="member-main">
                  <strong>{member.name || member.email}</strong>
                  <small>{member.email}</small>
                </span>
                <StatusBadge status={member.status} />
                <span className="role-list">
                  {member.roles.map((role) => (
                    <span key={role}>{titleCase(role)}</span>
                  ))}
                  {member.capabilities?.includes("vault") ? (
                    <span>Vault</span>
                  ) : null}
                </span>
                <span className="group-list">
                  {member.groupIds.length} groups
                </span>
                <ArrowRight />
              </button>
            ))
          ) : (
            <div className="member-search-empty">
              <Search />
              <span>No members match “{memberQuery.trim()}”.</span>
            </div>
          )}
        </div>
      </section>
      {supportGrants.length ? (
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Temporary identities</p>
              <h2>Active support access</h2>
            </div>
            <LockKeyhole />
          </div>
          {supportGrants.map((grant) => (
            <div className="member-row" key={grant.id}>
              <span className="avatar">
                {initials(grant.displayName, grant.email)}
              </span>
              <span className="member-main">
                <strong>{grant.displayName || grant.email}</strong>
                <small>
                  {grant.email} · {titleCase(grant.role)} access granted{" "}
                  {formatDate(grant.grantedAt)}
                </small>
                <small>
                  Expires {formatDate(grant.expiresAt, true)} — every action is
                  recorded in this workspace&apos;s audit history
                </small>
              </span>
              <StatusBadge status="active" />
              {grant.status === "active" ? (
                <button
                  className="button danger-button small"
                  disabled={busy}
                  onClick={() => onRevokeSupport(grant)}
                >
                  <Trash2 /> Revoke now
                </button>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      <section className="card table-card">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Signed links</p>
            <h2>Invitations</h2>
          </div>
        </div>
        {invitations.length ? (
          invitations.map((invite) => {
            const expired = Date.parse(invite.expiresAt) <= renderedAt;
            const status = invite.revokedAt
              ? "revoked"
              : invite.useCount >= invite.maxUses
                ? "used"
                : expired
                  ? "expired"
                  : "active";
            return (
              <div className="invite-row" key={invite.id}>
                <span className="invite-icon">
                  <Link2 />
                </span>
                <span className="member-main">
                  <strong>
                    {invite.label || `${titleCase(invite.role)} invitation`}
                  </strong>
                  <small>
                    Expires {formatDate(invite.expiresAt, true)} ·{" "}
                    {invite.useCount}/{invite.maxUses} uses
                  </small>
                </span>
                <StatusBadge status={status} />
                {status === "active" ? (
                  <button
                    className="button ghost small"
                    disabled={busy}
                    onClick={() => onRevoke(invite.id)}
                  >
                    Revoke
                  </button>
                ) : null}
              </div>
            );
          })
        ) : (
          <EmptyState
            icon={Link2}
            title="No invitation links"
            description="Create a signed, expiring link with a basic preassigned role."
          />
        )}
      </section>
    </div>
  );
}

function SupportDecisionDialog({
  request,
  busy,
  onClose,
  onDecide,
}: {
  request: SupportAccessRequest;
  busy: boolean;
  onClose: () => void;
  onDecide: (
    approve: boolean,
    grantedRole: WorkspaceRole,
    grantedDurationHours: number,
    explicitAdministrator: boolean,
  ) => Promise<void>;
}) {
  const [role, setRole] = useState<WorkspaceRole>(request.requestedRole);
  const [hours, setHours] = useState(request.requestedDurationHours);
  const [explicit, setExplicit] = useState(false);
  return (
    <Modal
      title="Review temporary support access"
      eyebrow={`${request.requesterName || request.requesterEmail}`}
      onClose={onClose}
    >
      <div className="modal-form">
        <p className="modal-copy">
          {request.requesterEmail} requested {titleCase(request.requestedRole)}{" "}
          access for {request.requestedDurationHours} hours to this workspace.
          Approving grants temporary access that expires automatically and is
          fully audited; membership, domains, invitations, and groups stay
          locked for support identities.
        </p>
        <div className="support-reason-box">
          <strong>Reason</strong>
          <p>{request.reason}</p>
        </div>
        <div className="field">
          <span>Granted role (you may adjust)</span>
          <SelectMenu
            className="form-select"
            value={role}
            onChange={setRole}
            ariaLabel="Granted role"
            options={WORKSPACE_ROLES.map((item) => ({
              value: item,
              label: titleCase(item),
            }))}
          />
        </div>
        <div className="field">
          <span>Duration (1–168 hours)</span>
          <input
            type="number"
            min={1}
            max={168}
            value={hours}
            onChange={(event) =>
              setHours(
                Math.max(1, Math.min(168, Number(event.target.value) || 1)),
              )
            }
          />
        </div>
        {role === "administrator" ? (
          <label className="choice-row emphasized">
            <input
              type="checkbox"
              checked={explicit}
              onChange={(event) => setExplicit(event.target.checked)}
            />
            <span>
              <strong>Explicitly approve administrator-level support</strong>
              <small>
                The support identity may operate the workspace but cannot change
                membership, invitations, domains, groups, or support governance.
              </small>
            </span>
          </label>
        ) : null}
        <footer className="modal-footer">
          <span />
          <button
            className="button secondary"
            type="button"
            onClick={() =>
              void onDecide(
                false,
                request.requestedRole,
                request.requestedDurationHours,
                false,
              )
            }
            disabled={busy}
          >
            Deny
          </button>
          <button
            className="button primary"
            type="button"
            disabled={busy || (role === "administrator" && !explicit)}
            onClick={() => void onDecide(true, role, hours, explicit)}
          >
            <ShieldCheck /> Approve access
          </button>
        </footer>
      </div>
    </Modal>
  );
}

function MemberDialog({
  member,
  busy,
  onClose,
  onSave,
  onSuspend,
}: {
  member: WorkspaceMember;
  busy: boolean;
  onClose: () => void;
  onSave: (
    roles: WorkspaceRole[],
    capabilities: Array<"vault">,
  ) => Promise<void>;
  onSuspend: () => Promise<void>;
}) {
  const [roles, setRoles] = useState(member.roles);
  const [vault, setVault] = useState(
    member.capabilities?.includes("vault") ?? false,
  );
  return (
    <Modal
      title={member.name || member.email}
      eyebrow="Member permissions"
      onClose={onClose}
    >
      <div className="modal-form member-permissions-form">
        <div className="identity-card">
          <span className="avatar large">
            {initials(member.name, member.email)}
          </span>
          <span>
            <strong>{member.name || member.email}</strong>
            <small>{member.email}</small>
          </span>
          <StatusBadge status={member.status} />
        </div>
        <div className="role-picker">
          <span className="field-label">Workspace roles</span>
          {WORKSPACE_ROLES.map((role) => (
            <label className="choice-row" key={role}>
              <input
                type="checkbox"
                checked={roles.includes(role)}
                onChange={() =>
                  setRoles((items) =>
                    items.includes(role)
                      ? items.filter((item) => item !== role)
                      : [...items, role],
                  )
                }
              />
              <span>
                <strong>{titleCase(role)}</strong>
                <small>{ROLE_COPY[role]}</small>
              </span>
            </label>
          ))}
        </div>
        <label className="choice-row emphasized">
          <input
            type="checkbox"
            checked={vault}
            onChange={(event) => setVault(event.target.checked)}
          />
          <span>
            <strong>Encrypted vault access</strong>
            <small>
              Separate capability for storing and decrypting workspace
              credentials.
            </small>
          </span>
        </label>
        <p className="privacy-caption">
          <Shield /> Changing roles or vault access does not add the member to
          any content audience.
        </p>
        <footer className="modal-footer">
          <button
            className="button danger-button"
            type="button"
            disabled={busy}
            onClick={onSuspend}
          >
            {member.status === "suspended" ? "Restore" : "Suspend"}
          </button>
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="button"
            disabled={busy || roles.length === 0}
            onClick={() => onSave(roles, vault ? ["vault"] : [])}
          >
            <Check /> Save
          </button>
        </footer>
      </div>
    </Modal>
  );
}

function InviteDialog({
  busy,
  origin,
  onClose,
  onCreate,
}: {
  busy: boolean;
  origin: string;
  onClose: () => void;
  onCreate: (payload: {
    email: string;
    label: string;
    role: WorkspaceRole;
    expiresInHours: number;
    maxUses: number;
  }) => Promise<{ token: string } | void>;
}) {
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("viewer");
  const [expires, setExpires] = useState(72);
  const [url, setUrl] = useState("");
  return (
    <Modal
      title="Invite a teammate"
      eyebrow="Signed workspace access"
      onClose={onClose}
    >
      <form
        className="modal-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await onCreate({
            email: email.trim().toLowerCase(),
            label: label.trim() || `Invite ${email.trim().toLowerCase()}`,
            role,
            expiresInHours: expires,
            maxUses: 1,
          });
          if (result?.token)
            setUrl(`${origin}/app?invite=${encodeURIComponent(result.token)}`);
        }}
      >
        {url ? (
          <div className="created-invite">
            <CheckCircle2 />
            <div>
              <strong>Invitation ready</strong>
              <p>The token is shown once. Copy it now.</p>
            </div>
            <div className="copy-field">
              <input readOnly value={url} />
              <button
                className="button secondary"
                type="button"
                onClick={() => navigator.clipboard.writeText(url)}
              >
                <Copy /> Copy
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="field">
              <span>Invitee email</span>
              <input
                required
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="teammate@example.com"
              />
              <small>
                The credential is bound to this exact verified email address.
              </small>
            </label>
            <label className="field">
              <span>Internal label</span>
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="August contractor onboarding"
              />
            </label>
            <div className="field">
              <span>Preassigned basic role</span>
              <SelectMenu
                className="form-select"
                value={role}
                onChange={setRole}
                ariaLabel="Preassigned basic role"
                options={WORKSPACE_ROLES.filter(
                  (item) => item !== "administrator",
                ).map((item) => ({ value: item, label: titleCase(item) }))}
              />
              <small>
                Administrator access must be assigned after membership is
                verified.
              </small>
            </div>
            <div className="form-grid two">
              <div className="field">
                <span>Expires after</span>
                <SelectMenu
                  className="form-select"
                  value={String(expires)}
                  onChange={(value) => setExpires(Number(value))}
                  ariaLabel="Invitation expiry"
                  options={[
                    { value: "24", label: "24 hours" },
                    { value: "72", label: "3 days" },
                    { value: "168", label: "7 days" },
                    { value: "720", label: "30 days" },
                  ]}
                />
              </div>
              <div className="field">
                <span>Maximum uses</span>
                <div className="support-reason-box">
                  <strong>1</strong>
                  <p>Every pilot invitation is single-use.</p>
                </div>
              </div>
            </div>
            <p className="privacy-caption">
              <LockKeyhole /> No generic links. Every redemption requires the
              exact verified email, is single-use, expires, and is audited.
            </p>
          </>
        )}
        <footer className="modal-footer">
          <span />
          <button className="button secondary" type="button" onClick={onClose}>
            {url ? "Done" : "Cancel"}
          </button>
          {!url ? (
            <button
              className="button primary"
              type="submit"
              disabled={busy || !email.includes("@")}
            >
              {busy ? <LoaderCircle className="spin" /> : <Link2 />} Create
              invitation
            </button>
          ) : null}
        </footer>
      </form>
    </Modal>
  );
}

function SupportView({
  tickets,
  busy,
  onCreate,
  onReply,
  onClose,
}: {
  tickets: SupportTicket[];
  busy: boolean;
  onCreate: (subject: string, message: string) => Promise<void>;
  onReply: (ticketId: string, message: string) => Promise<void>;
  onClose: (ticketId: string) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState(tickets[0]?.id ?? "");
  const [creating, setCreating] = useState(tickets.length === 0);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const selected =
    tickets.find((ticket) => ticket.id === selectedId) ?? tickets[0];
  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">In-app support</p>
          <h1>Support</h1>
          <p>
            Start a private support thread with a one-business-day response
            target. Email notices never include message content.
          </p>
        </div>
        <button
          className="button primary"
          type="button"
          disabled={busy}
          onClick={() => setCreating(true)}
        >
          <Plus /> New ticket
        </button>
      </div>
      <div className="support-layout">
        <aside className="card support-list" aria-label="Support tickets">
          {tickets.map((ticket) => (
            <button
              type="button"
              className={
                ticket.id === selected?.id
                  ? "support-ticket active"
                  : "support-ticket"
              }
              key={ticket.id}
              onClick={() => {
                setSelectedId(ticket.id);
                setCreating(false);
              }}
            >
              <strong>{ticket.subject}</strong>
              <small>
                {titleCase(ticket.status.replace("_", " "))} · updated{" "}
                {formatDate(ticket.updatedAt, true)}
              </small>
            </button>
          ))}
          {!tickets.length ? (
            <p className="empty-copy">No support tickets yet.</p>
          ) : null}
        </aside>
        <section className="card support-thread">
          {creating ? (
            <form
              className="modal-form"
              onSubmit={async (event) => {
                event.preventDefault();
                await onCreate(subject.trim(), message.trim());
                setSubject("");
                setMessage("");
                setCreating(false);
              }}
            >
              <div>
                <p className="eyebrow">New request</p>
                <h2>How can we help?</h2>
                <p className="modal-copy">
                  Do not paste guide text, screenshots, credentials, secrets,
                  payment details, health data, or national IDs. Attachments and
                  inbound-email replies are not supported.
                </p>
              </div>
              <label className="field">
                <span>Subject</span>
                <input
                  required
                  minLength={4}
                  maxLength={160}
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Message</span>
                <textarea
                  required
                  minLength={10}
                  maxLength={4000}
                  rows={8}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </label>
              <footer className="modal-footer">
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setCreating(false)}
                >
                  Cancel
                </button>
                <button
                  className="button primary"
                  type="submit"
                  disabled={
                    busy ||
                    subject.trim().length < 4 ||
                    message.trim().length < 10
                  }
                >
                  {busy ? <LoaderCircle className="spin" /> : <LifeBuoy />} Send
                  securely
                </button>
              </footer>
            </form>
          ) : selected ? (
            <>
              <header className="support-thread-header">
                <div>
                  <p className="eyebrow">
                    {titleCase(selected.status.replace("_", " "))}
                  </p>
                  <h2>{selected.subject}</h2>
                  <small>
                    Initial response target:{" "}
                    {formatDate(selected.responseTargetAt, true)}
                  </small>
                </div>
                {selected.status !== "closed" ? (
                  <button
                    className="button ghost small"
                    type="button"
                    disabled={busy}
                    onClick={() => void onClose(selected.id)}
                  >
                    Close ticket
                  </button>
                ) : null}
              </header>
              <div className="support-messages">
                {selected.messages.map((item) => (
                  <article
                    className={
                      item.authorKind === "support"
                        ? "support-message support"
                        : "support-message"
                    }
                    key={item.id}
                  >
                    <header>
                      <strong>{item.authorName}</strong>
                      <span>
                        {item.authorKind === "support"
                          ? "KnowHow support"
                          : "Workspace"}{" "}
                        · {formatDate(item.createdAt, true)}
                      </span>
                    </header>
                    <p>{item.body}</p>
                  </article>
                ))}
              </div>
              {selected.status !== "closed" ? (
                <form
                  className="support-reply"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (message.trim().length < 2) return;
                    await onReply(selected.id, message.trim());
                    setMessage("");
                  }}
                >
                  <label className="field">
                    <span>Reply</span>
                    <textarea
                      rows={4}
                      minLength={2}
                      maxLength={4000}
                      required
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      placeholder="Do not include sensitive data."
                    />
                  </label>
                  <button
                    className="button primary"
                    type="submit"
                    disabled={busy || message.trim().length < 2}
                  >
                    {busy ? <LoaderCircle className="spin" /> : <ArrowRight />}{" "}
                    Reply
                  </button>
                </form>
              ) : null}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function SettingsView({
  workspaceId,
  workspaceName,
  initial,
  busy,
  canManageDomains,
  onSave,
  onSaveDomains,
  onRefresh,
}: {
  workspaceId: string;
  workspaceName: string;
  initial: WorkspaceSettings;
  busy: boolean;
  canManageDomains: boolean;
  onSave: (settings: WorkspaceSettings) => Promise<void>;
  onSaveDomains: (domains: string[]) => Promise<void>;
  onRefresh: () => Promise<BootstrapResponse>;
}) {
  const [settings, setSettings] = useState(initial);
  const [domains, setDomains] = useState(initial.allowedDomains.join("\n"));
  const [hosts, setHosts] = useState(initial.excludedCaptureHosts.join("\n"));
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState("");
  const [domainBusy, setDomainBusy] = useState(false);
  const update = <K extends keyof WorkspaceSettings>(
    key: K,
    value: WorkspaceSettings[K],
  ) => setSettings((current) => ({ ...current, [key]: value }));
  const disabled = busy || logoBusy;
  const uniqueList = (value: string) => [
    ...new Set(
      value
        .split(/\r?\n|,/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  async function refreshLogoState() {
    const refreshed = await onRefresh();
    const logoUrl = refreshed.activeWorkspace?.workspace.settings.logoUrl;
    setSettings((current) => ({ ...current, logoUrl: logoUrl ?? null }));
  }
  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Workspace administration</p>
          <h1>Settings & policies</h1>
          <p>
            Control identity eligibility, capture boundaries, branding, and
            restricted exports.
          </p>
        </div>
        <button
          className="button primary"
          disabled={disabled}
          onClick={() =>
            onSave({ ...settings, excludedCaptureHosts: uniqueList(hosts) })
          }
        >
          <Check /> Save settings
        </button>
      </div>
      <div className="settings-grid">
        <section className="card settings-card">
          <div className="settings-title">
            <span>
              <Paintbrush />
            </span>
            <div>
              <h2>Document identity</h2>
              <p>Applied to the app and generated guide exports.</p>
            </div>
          </div>
          <div className="logo-upload">
            <WorkspaceLogo
              workspaceId={workspaceId}
              workspaceName={workspaceName}
              logoKey={settings.logoUrl}
              size="lg"
            />
            <div>
              <strong>
                {settings.logoUrl
                  ? "Workspace logo configured"
                  : "Workspace logo placeholder"}
              </strong>
              <small>
                PNG or JPEG, up to 1 MB. The stored identifier remains private.
              </small>
            </div>
            <label
              className={`button secondary small${disabled ? " disabled" : ""}`}
            >
              <ImagePlus /> {settings.logoUrl ? "Replace logo" : "Upload logo"}
              <input
                className="visually-hidden"
                type="file"
                accept="image/png,image/jpeg"
                disabled={disabled}
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  setLogoError("");
                  if (
                    !(["image/png", "image/jpeg"] as string[]).includes(
                      file.type,
                    ) ||
                    file.size > 1024 * 1024
                  ) {
                    setLogoError(
                      "Choose a PNG or JPEG logo no larger than 1 MB.",
                    );
                    return;
                  }
                  setLogoBusy(true);
                  try {
                    await uploadWorkspaceLogo(workspaceId, file);
                    await refreshLogoState();
                  } catch (error) {
                    setLogoError(messageFromError(error));
                  } finally {
                    setLogoBusy(false);
                  }
                }}
              />
            </label>
            {settings.logoUrl ? (
              <button
                className="button ghost small"
                type="button"
                disabled={disabled}
                onClick={async () => {
                  setLogoBusy(true);
                  setLogoError("");
                  try {
                    await removeWorkspaceLogo(workspaceId);
                    await refreshLogoState();
                  } catch (error) {
                    setLogoError(messageFromError(error));
                  } finally {
                    setLogoBusy(false);
                  }
                }}
              >
                <Trash2 /> Remove
              </button>
            ) : null}
          </div>
          {logoError ? (
            <p className="form-error" role="alert">
              {logoError}
            </p>
          ) : null}
          <div className="form-grid two">
            <label className="field color-field">
              <span>Document accent</span>
              <span>
                <input
                  type="color"
                  value={settings.accentColor}
                  onChange={(event) =>
                    update("accentColor", event.target.value)
                  }
                />
                <input
                  value={settings.accentColor}
                  onChange={(event) =>
                    update("accentColor", event.target.value)
                  }
                />
              </span>
              <small>
                Used in guide branding and annotations, not the application
                interface.
              </small>
            </label>
            <label className="field color-field">
              <span>Click target</span>
              <span>
                <input
                  type="color"
                  value={settings.clickTargetColor}
                  onChange={(event) =>
                    update("clickTargetColor", event.target.value)
                  }
                />
                <input
                  value={settings.clickTargetColor}
                  onChange={(event) =>
                    update("clickTargetColor", event.target.value)
                  }
                />
              </span>
            </label>
          </div>
          <label className="choice-row emphasized">
            <input
              type="checkbox"
              checked={settings.removeBranding}
              onChange={(event) =>
                update("removeBranding", event.target.checked)
              }
            />
            <span>
              <strong>Remove KnowHow branding</strong>
              <small>
                Available as a workspace or subscription entitlement.
              </small>
            </span>
          </label>
        </section>
        {canManageDomains ? (
          <section className="card settings-card">
            <div className="settings-title">
              <span>
                <Mail />
              </span>
              <div>
                <h2>Approved email domains</h2>
                <p>
                  Invitation policy only. A domain never creates an account or
                  grants access.
                </p>
              </div>
            </div>
            <label className="field">
              <span>One exact domain per line</span>
              <textarea
                rows={6}
                value={domains}
                onChange={(event) => setDomains(event.target.value)}
                placeholder={"example.com\nsubsidiary.co.uk"}
              />
            </label>
            <p className="privacy-caption">
              <ShieldCheck /> Email-scoped invitations must match exactly.
              Subdomains, lookalikes, and suffix matches are rejected.
            </p>
            <button
              className="button secondary"
              type="button"
              disabled={disabled || domainBusy}
              onClick={async () => {
                setDomainBusy(true);
                try {
                  await onSaveDomains(uniqueList(domains));
                } finally {
                  setDomainBusy(false);
                }
              }}
            >
              {domainBusy ? <LoaderCircle className="spin" /> : <Check />} Save
              domains
            </button>
          </section>
        ) : (
          <section className="card settings-card">
            <div className="settings-title">
              <span>
                <Mail />
              </span>
              <div>
                <h2>Approved email domains</h2>
                <p>
                  Shared organization domains can be changed only by an
                  organization owner or administrator.
                </p>
              </div>
            </div>
            <p className="privacy-caption">
              <ShieldCheck /> Workspace administration alone never changes
              organization-wide identity eligibility.
            </p>
          </section>
        )}
        <section className="card settings-card">
          <div className="settings-title">
            <span>
              <Laptop />
            </span>
            <div>
              <h2>Capture policy</h2>
              <p>Blocked hosts are enforced by the paired extension.</p>
            </div>
          </div>
          <label className="field">
            <span>Excluded hostnames</span>
            <textarea
              rows={6}
              value={hosts}
              onChange={(event) => setHosts(event.target.value)}
              placeholder={"vault.example.com\npasswords.example.net"}
            />
          </label>
          <p className="privacy-caption">
            <LockKeyhole /> Password managers, browser internals, extension
            pages, and incognito sessions are always blocked.
          </p>
        </section>
        <section className="card settings-card">
          <div className="settings-title">
            <span>
              <FileDown />
            </span>
            <div>
              <h2>Export controls</h2>
              <p>Live links always retain audience checks.</p>
            </div>
          </div>
          <label className="choice-row emphasized">
            <input
              type="checkbox"
              checked={settings.allowRestrictedExports}
              onChange={(event) =>
                update("allowRestrictedExports", event.target.checked)
              }
            />
            <span>
              <strong>Allow restricted-guide exports</strong>
              <small>
                Each permitted export is recorded in the audit history.
              </small>
            </span>
          </label>
          <label className="choice-row emphasized">
            <input
              type="checkbox"
              checked={settings.watermarkExports}
              onChange={(event) =>
                update("watermarkExports", event.target.checked)
              }
            />
            <span>
              <strong>Watermark exports</strong>
              <small>
                Add viewer, workspace, and export date to generated files.
              </small>
            </span>
          </label>
        </section>
      </div>
    </div>
  );
}

function vaultMetadata(item: VaultItem | null) {
  try {
    const value = JSON.parse(item?.metadataJson ?? "{}") as Record<
      string,
      unknown
    >;
    return {
      username: typeof value.username === "string" ? value.username : "",
      url: typeof value.url === "string" ? value.url : "",
      notes: typeof value.notes === "string" ? value.notes : "",
    };
  } catch {
    return { username: "", url: "", notes: "" };
  }
}

function VaultView({
  items,
  busy,
  onNew,
  onEdit,
  onReveal,
  onDelete,
}: {
  items: VaultItem[];
  busy: boolean;
  onNew: () => void;
  onEdit: (item: VaultItem) => void;
  onReveal: (item: VaultItem) => void;
  onDelete: (item: VaultItem) => void;
}) {
  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Encrypted credentials</p>
          <h1>Vault</h1>
          <p>
            Keep credentials out of guides. Secrets are encrypted and decrypted
            only in this browser with your passphrase.
          </p>
        </div>
        <button
          className="button primary"
          type="button"
          disabled={busy}
          onClick={onNew}
        >
          <Plus /> New vault item
        </button>
      </div>
      <section className="card table-card">
        {items.length ? (
          <div className="vault-list">
            {items.map((item) => {
              const metadata = vaultMetadata(item);
              return (
                <article className="vault-row" key={item.id}>
                  <span className="vault-icon">
                    <KeyRound />
                  </span>
                  <span className="member-main">
                    <strong>{item.title}</strong>
                    <small>
                      {metadata.username ||
                        metadata.url ||
                        "Encrypted workspace credential"}{" "}
                      · updated {formatDate(item.updatedAt)}
                    </small>
                  </span>
                  <button
                    className="button secondary small"
                    type="button"
                    disabled={busy}
                    onClick={() => onReveal(item)}
                  >
                    <Eye /> Reveal
                  </button>
                  <button
                    className="button ghost small"
                    type="button"
                    disabled={busy}
                    onClick={() => onEdit(item)}
                  >
                    Edit details
                  </button>
                  <button
                    className="icon-button danger"
                    type="button"
                    disabled={busy}
                    aria-label={`Delete ${item.title}`}
                    onClick={() => onDelete(item)}
                  >
                    <Trash2 />
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={KeyRound}
            title="No vault items"
            description="Store the first encrypted credential instead of embedding it in a restricted guide."
            action={
              <button
                className="button primary"
                type="button"
                disabled={busy}
                onClick={onNew}
              >
                <Plus /> New vault item
              </button>
            }
          />
        )}
      </section>
      <p className="privacy-caption">
        <ShieldCheck /> KnowHow stores only an authenticated encryption
        envelope. Passphrases and plaintext are never sent to the server or
        audit log.
      </p>
    </div>
  );
}

function VaultEditorDialog({
  item,
  busy,
  onClose,
  onSave,
}: {
  item: VaultItem | null;
  busy: boolean;
  onClose: () => void;
  onSave: (payload: {
    id?: string;
    title: string;
    encryptedEnvelopeJson: string;
    metadataJson: string;
  }) => Promise<void>;
}) {
  const metadata = vaultMetadata(item);
  const [title, setTitle] = useState(item?.title ?? "");
  const [username, setUsername] = useState(metadata.username);
  const [url, setUrl] = useState(metadata.url);
  const [notes, setNotes] = useState(metadata.notes);
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  return (
    <Modal
      title={item ? `Edit ${item.title}` : "New vault item"}
      eyebrow="Client-side encryption"
      onClose={onClose}
    >
      <form
        className="modal-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            let encryptedEnvelopeJson = item?.encryptedEnvelopeJson ?? "";
            if (secret) {
              if (passphrase.length < 12)
                throw new Error(
                  "Use a vault passphrase of at least 12 characters.",
                );
              encryptedEnvelopeJson = JSON.stringify(
                await encryptSecretValue(secret, passphrase),
              );
            }
            if (!encryptedEnvelopeJson)
              throw new Error("Enter the secret value and a vault passphrase.");
            await onSave({
              ...(item ? { id: item.id } : {}),
              title: title.trim(),
              encryptedEnvelopeJson,
              metadataJson: JSON.stringify({
                username: username.trim(),
                url: url.trim(),
                notes: notes.trim(),
              }),
            });
            setSecret("");
            setPassphrase("");
          } catch (nextError) {
            setError(messageFromError(nextError));
          }
        }}
      >
        <label className="field">
          <span>Title</span>
          <input
            required
            minLength={2}
            maxLength={160}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Microsoft 365 break-glass account"
          />
        </label>
        <div className="form-grid two">
          <label className="field">
            <span>Username or account</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>Sign-in URL</span>
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://login.example.com"
            />
          </label>
        </div>
        <label className="field">
          <span>{item ? "Replacement secret (optional)" : "Secret value"}</span>
          <textarea
            required={!item}
            rows={3}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>
            Vault passphrase{" "}
            {item ? "(required only when replacing the secret)" : ""}
          </span>
          <input
            type="password"
            required={!item || Boolean(secret)}
            minLength={12}
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label className="field">
          <span>Non-secret notes</span>
          <textarea
            rows={3}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="modal-footer">
          <span />
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || title.trim().length < 2}
          >
            {busy ? <LoaderCircle className="spin" /> : <ShieldCheck />} Encrypt
            & save
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function VaultRevealDialog({
  item,
  busy,
  onClose,
}: {
  item: VaultItem;
  busy: boolean;
  onClose: () => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [plaintext, setPlaintext] = useState("");
  const [error, setError] = useState("");
  return (
    <Modal
      title={item.title}
      eyebrow="Decrypt in this browser"
      onClose={onClose}
    >
      <div className="modal-form">
        {plaintext ? (
          <div className="revealed-secret">
            <span className="field-label">Decrypted value</span>
            <pre>{plaintext}</pre>
            <button
              className="button secondary"
              type="button"
              onClick={() => void navigator.clipboard.writeText(plaintext)}
            >
              <Copy /> Copy value
            </button>
          </div>
        ) : (
          <>
            <label className="field">
              <span>Vault passphrase</span>
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                autoComplete="current-password"
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                }}
              />
            </label>
            <button
              className="button primary"
              type="button"
              disabled={busy || !passphrase}
              onClick={async () => {
                setError("");
                try {
                  const envelope = JSON.parse(
                    item.encryptedEnvelopeJson,
                  ) as EncryptedSecretEnvelope;
                  setPlaintext(await decryptSecretValue(envelope, passphrase));
                  setPassphrase("");
                } catch (nextError) {
                  setError(messageFromError(nextError));
                }
              }}
            >
              <Eye /> Decrypt locally
            </button>
          </>
        )}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="privacy-caption">
          <LockKeyhole /> Closing this dialog removes the decrypted value from
          KnowHow&apos;s UI state.
        </p>
        <footer className="modal-footer">
          <span />
          <button className="button primary" type="button" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </Modal>
  );
}

// The platform table can scroll horizontally, so its row actions use the
// portaled shadcn menu rather than a locally positioned overlay.
function RowMenu({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="icon-button"
        type="button"
        aria-label="Workspace actions"
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="row-menu-pop">
        {Children.map(children, (child) => {
          if (
            !isValidElement<{
              disabled?: boolean;
              onClick?: () => void;
              children?: ReactNode;
            }>(child)
          )
            return null;
          return (
            <DropdownMenuItem
              disabled={child.props.disabled}
              onClick={child.props.onClick}
            >
              {child.props.children}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PlatformView({
  platform,
  busy,
  onProvision,
  onStatus,
  onAssign,
  onRequestSupport,
  onExtendSubscription,
  onConvertSubscription,
  onApproveDeletion,
  onRevokeAppointment,
}: {
  platform: NonNullable<BootstrapResponse["platform"]>;
  busy: boolean;
  onProvision: () => void;
  onStatus: (
    workspaceId: string,
    status: "active" | "suspended" | "archived",
  ) => void;
  onAssign: (workspace: PlatformWorkspace) => void;
  onRequestSupport: (workspace: PlatformWorkspace) => void;
  onExtendSubscription: (
    workspaceId: string,
    expiresAt: string,
    graceDays: number,
    retentionDays: number,
  ) => Promise<unknown>;
  onConvertSubscription: (
    workspaceId: string,
    manualReference: string,
    expiresAt: string | null,
  ) => Promise<unknown>;
  onApproveDeletion: (caseId: string, confirmation: string) => Promise<unknown>;
  onRevokeAppointment: (appointment: AdminAppointment) => void;
}) {
  const { metrics, workspaces, settings, appointments } = platform;
  const [query, setQuery] = useState("");
  const [lifecycleAction, setLifecycleAction] = useState<{
    mode: "extend" | "convert";
    openedAt: number;
    subscription: NonNullable<
      BootstrapResponse["platform"]
    >["subscriptions"][number];
  } | null>(null);
  const [deletionCase, setDeletionCase] = useState<
    NonNullable<BootstrapResponse["platform"]>["deletionCases"][number] | null
  >(null);
  const platformNow = Date.parse(platform.generatedAt);
  const workspaceName = (workspaceId: string) =>
    workspaces.find((workspace) => workspace.id === workspaceId)?.name ??
    "Unknown workspace";
  const filtered = workspaces.filter((workspace) => {
    const term = query.trim().toLowerCase();
    if (!term) return true;
    return (
      workspace.name.toLowerCase().includes(term) ||
      workspace.slug.toLowerCase().includes(term) ||
      workspace.administrators.some(
        (admin) =>
          admin.name.toLowerCase().includes(term) ||
          admin.email.toLowerCase().includes(term),
      )
    );
  });
  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Product owner</p>
          <h1>Platform administration</h1>
          <p>
            Manage tenant health and aggregate usage without opening customer
            document contents or secrets.
          </p>
        </div>
        <div className="modal-actions">
          <span className="platform-shield">
            <ShieldCheck /> Content-private metrics
          </span>
          <button
            className="button primary"
            type="button"
            disabled={busy}
            onClick={onProvision}
          >
            <Building2 /> Provision organization
          </button>
        </div>
      </div>
      <section className="metric-grid platform-metrics">
        <MetricCard
          label="Users"
          value={metrics.users}
          hint="Across all workspaces"
          icon={Users}
        />
        <MetricCard
          label="Active workspaces"
          value={metrics.activeWorkspaces}
          hint={`${metrics.suspendedWorkspaces} suspended · ${metrics.archivedWorkspaces} archived`}
          icon={Building2}
          tone="accent"
        />
        <MetricCard
          label="Guides"
          value={metrics.published + metrics.drafts}
          hint={`${metrics.published} published · ${metrics.drafts} drafts`}
          icon={BookOpen}
        />
        <MetricCard
          label="Captures"
          value={metrics.captures}
          hint={`${metrics.failedOperations} failed operations`}
          icon={Sparkles}
        />
        <MetricCard
          label="Views"
          value={metrics.views}
          hint={`${metrics.completions} completions`}
          icon={Eye}
        />
        <MetricCard
          label="Exports"
          value={metrics.exports}
          hint={formatBytes(metrics.storageBytes)}
          icon={FileDown}
        />
      </section>
      <section className="card table-card">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Operational health</p>
            <h2>Pilot control plane</h2>
          </div>
          <span className="privacy-caption">
            <ShieldCheck /> Counts and timestamps only
          </span>
        </div>
        <div className="metric-grid operational-metrics">
          <MetricCard
            label="Failed notifications"
            value={platform.systemHealth.failedNotifications}
            hint="Queued delivery requires attention"
            icon={Mail}
            tone={
              platform.systemHealth.failedNotifications ? "warning" : undefined
            }
          />
          <MetricCard
            label="Overdue support"
            value={platform.systemHealth.overdueSupport}
            hint="One-business-day target"
            icon={LifeBuoy}
            tone={platform.systemHealth.overdueSupport ? "warning" : undefined}
          />
          <MetricCard
            label="Expiring soon"
            value={platform.systemHealth.expiringWithinSevenDays}
            hint="Within seven days"
            icon={CalendarDays}
            tone={
              platform.systemHealth.expiringWithinSevenDays
                ? "warning"
                : undefined
            }
          />
          <MetricCard
            label="Deletion approvals"
            value={platform.systemHealth.deletionApprovals}
            hint="Owner confirmation required"
            icon={Trash2}
            tone={
              platform.systemHealth.deletionApprovals ? "warning" : undefined
            }
          />
          <MetricCard
            label="Failed operations"
            value={platform.systemHealth.failedOperations}
            hint="Content-free usage events"
            icon={CircleAlert}
            tone={
              platform.systemHealth.failedOperations ? "warning" : undefined
            }
          />
        </div>
        {platform.provisioningRuns.length ? (
          <div className="empty-inline">
            <Building2 />
            <span>
              <strong>
                {platform.provisioningRuns.length} resumable provisioning{" "}
                {platform.provisioningRuns.length === 1 ? "draft" : "drafts"}
              </strong>
              <small>
                Most recent updated{" "}
                {formatDate(platform.provisioningRuns[0].updatedAt, true)} ·{" "}
                {platform.provisioningRuns[0].completedSteps.length} of 6 steps
                saved
              </small>
            </span>
            <button
              className="button secondary small"
              type="button"
              disabled={busy}
              onClick={onProvision}
            >
              Resume
            </button>
          </div>
        ) : null}
      </section>
      <section className="card table-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Tenant directory</p>
            <h2>Every workspace</h2>
          </div>
          <span className="privacy-caption">
            <LockKeyhole /> Metadata only
          </span>
        </div>
        <div className="filter-bar">
          <label className="search-field">
            <Search />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search workspaces, slugs, or administrators"
            />
          </label>
          <span className="result-count">
            {filtered.length}{" "}
            {filtered.length === 1 ? "workspace" : "workspaces"}
          </span>
        </div>
        <div className="platform-table">
          <div className="platform-row platform-head">
            <span>Workspace</span>
            <span>Administrators</span>
            <span>Guides</span>
            <span>Usage</span>
            <span>Storage</span>
            <span>Status</span>
            <span />
          </div>
          {filtered.map((workspace) => (
            <div className="platform-row" key={workspace.id}>
              <span className="workspace-cell">
                <span className="workspace-avatar">
                  {workspace.name.slice(0, 1)}
                </span>
                <span>
                  <strong>{workspace.name}</strong>
                  <small>
                    {workspace.memberCount} members · created{" "}
                    {formatDate(workspace.createdAt)}
                    {workspace.supportGrant
                      ? ` · support ${titleCase(workspace.supportGrant.role)} until ${formatDate(workspace.supportGrant.expiresAt, true)}`
                      : workspace.supportRequest?.status === "pending"
                        ? " · support request pending"
                        : ""}
                  </small>
                </span>
              </span>
              <span>
                {workspace.administrators.length ? (
                  workspace.administrators.map((admin) => (
                    <small key={admin.userId}>
                      {admin.name || admin.email}
                    </small>
                  ))
                ) : (
                  <small>None assigned</small>
                )}
                <button
                  className="text-button"
                  onClick={() => onAssign(workspace)}
                >
                  <UserCog /> Assign
                </button>
              </span>
              <span>
                <strong>{workspace.publishedCount}</strong>
                <small>{workspace.draftCount} drafts</small>
              </span>
              <span>
                <strong>{workspace.views} views</strong>
                <small>{workspace.exports} exports</small>
              </span>
              <span>{formatBytes(workspace.storageBytes)}</span>
              <span>
                <StatusBadge status={workspace.status} />
              </span>
              <span>
                <RowMenu>
                  {workspace.status === "active" && !workspace.supportGrant ? (
                    <button
                      disabled={busy}
                      onClick={() => onRequestSupport(workspace)}
                    >
                      <ShieldCheck /> Request support access
                    </button>
                  ) : null}
                  {workspace.status !== "active" ? (
                    <button
                      disabled={busy}
                      onClick={() => onStatus(workspace.id, "active")}
                    >
                      <RefreshCw /> Restore
                    </button>
                  ) : null}
                  {workspace.status === "active" ? (
                    <button
                      disabled={busy}
                      onClick={() => onStatus(workspace.id, "suspended")}
                    >
                      <Pause /> Suspend
                    </button>
                  ) : null}
                  {workspace.status !== "archived" ? (
                    <button
                      disabled={busy}
                      onClick={() => onStatus(workspace.id, "archived")}
                    >
                      <Archive /> Archive
                    </button>
                  ) : null}
                </RowMenu>
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className="card settings-card invitation-policy-card">
        <div className="settings-title">
          <span>
            <LockKeyhole />
          </span>
          <div>
            <h2>Invitation-only pilot</h2>
            <p>
              Public signup and self-service workspace creation are locked off.
              Organizations are created only through controlled provisioning,
              and every person needs an exact-email, single-use credential.
            </p>
          </div>
        </div>
        <div className="policy-lock-row">
          <StatusBadge status="active" />
          <span>
            <strong>
              Self-service limit: {settings.selfServiceWorkspaceLimit}
            </strong>
            <small>Server-enforced at zero for the external pilot.</small>
          </span>
        </div>
      </section>

      <section className="card table-card">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Commercial lifecycle</p>
            <h2>Subscriptions and entitlements</h2>
          </div>
          <span className="privacy-caption">
            <ShieldCheck /> Manual contracts only
          </span>
        </div>
        {platform.subscriptions.length ? (
          platform.subscriptions.map((subscription) => {
            const entitlements = platform.entitlements.filter(
              (entitlement) =>
                entitlement.workspaceId === subscription.workspaceId,
            );
            return (
              <div className="platform-ops-row" key={subscription.id}>
                <span className="invite-icon">
                  <CalendarDays />
                </span>
                <span className="member-main">
                  <strong>{workspaceName(subscription.workspaceId)}</strong>
                  <small>
                    {titleCase(subscription.kind)} · access{" "}
                    {titleCase(subscription.access)} ·
                    {subscription.expiresAt
                      ? ` expires ${formatDate(subscription.expiresAt, true)}`
                      : " no fixed expiry"}
                  </small>
                  <small>
                    {entitlements.length
                      ? entitlements
                          .map(
                            (entitlement) =>
                              `${titleCase(entitlement.kind)}: ${String(entitlement.value)}`,
                          )
                          .join(" · ")
                      : "No explicit entitlement overrides"}
                  </small>
                </span>
                <StatusBadge status={subscription.status} />
                <div className="modal-actions compact-actions">
                  {subscription.expiresAt ? (
                    <button
                      className="button secondary small"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setLifecycleAction({
                          mode: "extend",
                          subscription,
                          openedAt: Date.now(),
                        })
                      }
                    >
                      Extend
                    </button>
                  ) : null}
                  {subscription.kind !== "paid" ? (
                    <button
                      className="button secondary small"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setLifecycleAction({
                          mode: "convert",
                          subscription,
                          openedAt: Date.now(),
                        })
                      }
                    >
                      Record contract
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        ) : (
          <div className="empty-inline">
            <CalendarDays />
            <span>
              <strong>No subscriptions</strong>
              <small>
                Provisioning creates an explicit pilot subscription.
              </small>
            </span>
          </div>
        )}
      </section>

      <div className="settings-grid platform-operations-grid">
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Activation milestones</p>
              <h2>First-value progress</h2>
            </div>
            <Activity />
          </div>
          {platform.activation.length ? (
            platform.activation.map((activation) => {
              const achieved = [
                activation.firstPublishedAt,
                activation.firstTeammateViewAt,
                activation.firstTeammateCompletionAt,
              ].filter(Boolean).length;
              return (
                <div
                  className="platform-compact-row"
                  key={activation.workspaceId}
                >
                  <span className="member-main">
                    <strong>{workspaceName(activation.workspaceId)}</strong>
                    <small>
                      {activation.firstPublishedAt
                        ? `Published ${formatDate(activation.firstPublishedAt, true)}`
                        : "Awaiting first publication"}
                    </small>
                    <small>
                      {activation.firstTeammateViewAt
                        ? `Teammate view ${formatDate(activation.firstTeammateViewAt, true)}`
                        : "Awaiting teammate view"}
                      {activation.firstTeammateCompletionAt
                        ? ` · completion ${formatDate(activation.firstTeammateCompletionAt, true)}`
                        : " · awaiting completion"}
                    </small>
                  </span>
                  <strong>{achieved}/3</strong>
                </div>
              );
            })
          ) : (
            <p className="empty-copy">No activation events recorded.</p>
          )}
        </section>

        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Pilot leads</p>
              <h2>Controlled intake</h2>
            </div>
            <Mail />
          </div>
          {platform.leads.length ? (
            platform.leads.slice(0, 12).map((lead) => (
              <div className="platform-compact-row" key={lead.id}>
                <span className="member-main">
                  <strong>
                    {lead.organization || lead.contactName || lead.email}
                  </strong>
                  <small>
                    {lead.contactName || "Unnamed contact"} · {lead.email}
                  </small>
                  <small>
                    {titleCase(lead.kind)} · {formatDate(lead.occurredAt, true)}
                  </small>
                </span>
                <StatusBadge status={lead.status} />
              </div>
            ))
          ) : (
            <p className="empty-copy">No pilot requests recorded.</p>
          )}
        </section>

        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Support SLA</p>
              <h2>Open support work</h2>
            </div>
            <LifeBuoy />
          </div>
          {platform.support.length ? (
            platform.support.slice(0, 12).map((ticket) => {
              const overdue =
                ticket.status === "waiting_support" &&
                Date.parse(ticket.responseTargetAt) < platformNow;
              return (
                <div className="platform-compact-row" key={ticket.id}>
                  <span className="member-main">
                    <strong>{workspaceName(ticket.workspaceId)}</strong>
                    <small>
                      {ticket.requesterName} · target{" "}
                      {formatDate(ticket.responseTargetAt, true)}
                    </small>
                  </span>
                  <StatusBadge status={overdue ? "overdue" : ticket.status} />
                </div>
              );
            })
          ) : (
            <p className="empty-copy">No support cases recorded.</p>
          )}
        </section>

        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Delivery failures</p>
              <h2>Notification retry queue</h2>
            </div>
            <CircleAlert />
          </div>
          {platform.notificationFailures.length ? (
            platform.notificationFailures.slice(0, 12).map((failure) => (
              <div className="platform-compact-row" key={failure.id}>
                <span className="member-main">
                  <strong>{workspaceName(failure.workspaceId)}</strong>
                  <small>
                    {titleCase(failure.kind)} · last failure{" "}
                    {formatDate(failure.lastFailedAt, true)}
                  </small>
                </span>
                <strong>{failure.attempts} attempts</strong>
              </div>
            ))
          ) : (
            <p className="empty-copy">No failed notification deliveries.</p>
          )}
        </section>
      </div>

      <section className="card table-card deletion-control-card">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Retention boundary</p>
            <h2>Deletion approvals</h2>
          </div>
          <span className="privacy-caption">
            <Trash2 /> Two-stage purge
          </span>
        </div>
        {platform.deletionCases.length ? (
          platform.deletionCases.map((item) => {
            const eligible = Date.parse(item.eligibleAt) <= platformNow;
            return (
              <div className="platform-ops-row" key={item.id}>
                <span className="invite-icon danger-icon">
                  <Trash2 />
                </span>
                <span className="member-main">
                  <strong>{workspaceName(item.workspaceId)}</strong>
                  <small>
                    Retention eligibility {formatDate(item.eligibleAt, true)}
                  </small>
                  <small>
                    {item.confirmationText
                      ? "Typed platform-owner confirmation is required."
                      : "Only a platform owner can see the confirmation phrase."}
                  </small>
                </span>
                <StatusBadge status={item.status} />
                {item.status === "awaiting_approval" &&
                item.confirmationText ? (
                  <button
                    className="button danger-button small"
                    type="button"
                    disabled={busy || !eligible}
                    onClick={() => setDeletionCase(item)}
                  >
                    {eligible ? "Review deletion" : "Retention active"}
                  </button>
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="empty-inline">
            <ShieldCheck />
            <span>
              <strong>No deletion approvals pending</strong>
              <small>
                Expired tenants remain recoverable until retention ends and an
                owner explicitly approves purge.
              </small>
            </span>
          </div>
        )}
      </section>

      <section className="card table-card">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Platform audit</p>
            <h2>Recent control-plane changes</h2>
          </div>
          <History />
        </div>
        {platform.platformAudits.length ? (
          platform.platformAudits.slice(0, 20).map((audit) => (
            <div className="platform-compact-row" key={audit.id}>
              <span className="member-main">
                <strong>{titleCase(audit.action)}</strong>
                <small>{workspaceName(audit.workspaceId)}</small>
              </span>
              <time dateTime={audit.occurredAt}>
                {formatDate(audit.occurredAt, true)}
              </time>
            </div>
          ))
        ) : (
          <p className="empty-copy">No control-plane audit events recorded.</p>
        )}
      </section>
      {appointments.length ? (
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Client administrator appointments</p>
              <h2>Pending appointments</h2>
            </div>
            <LockKeyhole />
          </div>
          {appointments.map((appointment) => (
            <div className="invite-row" key={appointment.id}>
              <span className="invite-icon">
                <UserCog />
              </span>
              <span className="member-main">
                <strong>{appointment.email}</strong>
                <small>
                  Appointed administrator · expires{" "}
                  {formatDate(appointment.expiresAt, true)} · the acceptance
                  link was shown once at creation
                </small>
              </span>
              <StatusBadge status="active" />
              <button
                className="button ghost small"
                disabled={busy}
                onClick={() => onRevokeAppointment(appointment)}
              >
                Revoke
              </button>
            </div>
          ))}
        </section>
      ) : null}
      {lifecycleAction ? (
        <SubscriptionLifecycleDialog
          action={lifecycleAction}
          busy={busy}
          workspaceName={workspaceName(
            lifecycleAction.subscription.workspaceId,
          )}
          onClose={() => setLifecycleAction(null)}
          onExtend={onExtendSubscription}
          onConvert={onConvertSubscription}
        />
      ) : null}
      {deletionCase?.confirmationText ? (
        <DeletionApprovalDialog
          item={deletionCase}
          confirmationText={deletionCase.confirmationText}
          workspaceName={workspaceName(deletionCase.workspaceId)}
          busy={busy}
          onClose={() => setDeletionCase(null)}
          onApprove={onApproveDeletion}
        />
      ) : null}
    </div>
  );
}

function SubscriptionLifecycleDialog({
  action,
  workspaceName,
  busy,
  onClose,
  onExtend,
  onConvert,
}: {
  action: {
    mode: "extend" | "convert";
    openedAt: number;
    subscription: NonNullable<
      BootstrapResponse["platform"]
    >["subscriptions"][number];
  };
  workspaceName: string;
  busy: boolean;
  onClose: () => void;
  onExtend: (
    workspaceId: string,
    expiresAt: string,
    graceDays: number,
    retentionDays: number,
  ) => Promise<unknown>;
  onConvert: (
    workspaceId: string,
    manualReference: string,
    expiresAt: string | null,
  ) => Promise<unknown>;
}) {
  const extensionBase = Math.max(
    action.openedAt,
    action.subscription.expiresAt
      ? Date.parse(action.subscription.expiresAt)
      : action.openedAt,
  );
  const [expiryDate, setExpiryDate] = useState(
    action.mode === "extend"
      ? new Date(extensionBase + 7 * 86_400_000).toISOString().slice(0, 10)
      : "",
  );
  const [graceDays, setGraceDays] = useState(7);
  const [retentionDays, setRetentionDays] = useState(30);
  const [manualReference, setManualReference] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const toEndOfDayIso = (value: string) =>
    new Date(`${value}T23:59:59.000Z`).toISOString();

  return (
    <Modal
      title={
        action.mode === "extend"
          ? `Extend ${workspaceName}`
          : `Record contract · ${workspaceName}`
      }
      eyebrow="MFA-protected lifecycle change"
      onClose={onClose}
    >
      <form
        className="modal-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setWorking(true);
          setError("");
          try {
            if (action.mode === "extend") {
              await onExtend(
                action.subscription.workspaceId,
                toEndOfDayIso(expiryDate),
                graceDays,
                retentionDays,
              );
            } else {
              await onConvert(
                action.subscription.workspaceId,
                manualReference.trim(),
                expiryDate ? toEndOfDayIso(expiryDate) : null,
              );
            }
            onClose();
          } catch (nextError) {
            setError(messageFromError(nextError));
          } finally {
            setWorking(false);
          }
        }}
      >
        <p className="modal-copy">
          {action.mode === "extend"
            ? "Restores lifecycle access, moves the expiry forward, and cancels any pending deletion approval for this workspace."
            : "Records an externally executed contract or invoice. KnowHow does not collect payment in this pilot."}
        </p>
        {action.mode === "convert" ? (
          <label className="field">
            <span>Contract or invoice reference</span>
            <input
              required
              minLength={3}
              maxLength={128}
              value={manualReference}
              onChange={(event) => setManualReference(event.target.value)}
              placeholder="Contract 2026-014"
              autoComplete="off"
            />
          </label>
        ) : null}
        <label className="field">
          <span>
            {action.mode === "extend"
              ? "New expiry date"
              : "Contract expiry (optional)"}
          </span>
          <input
            type="date"
            required={action.mode === "extend"}
            value={expiryDate}
            onChange={(event) => setExpiryDate(event.target.value)}
          />
        </label>
        {action.mode === "extend" ? (
          <div className="form-grid two">
            <label className="field">
              <span>Grace period (days)</span>
              <input
                type="number"
                min={0}
                max={30}
                value={graceDays}
                onChange={(event) => setGraceDays(Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Retention after suspension (days)</span>
              <input
                type="number"
                min={30}
                max={365}
                value={retentionDays}
                onChange={(event) =>
                  setRetentionDays(Number(event.target.value))
                }
              />
            </label>
          </div>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="modal-footer">
          <span />
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={
              busy ||
              working ||
              (action.mode === "extend" && !expiryDate) ||
              (action.mode === "convert" && manualReference.trim().length < 3)
            }
          >
            {working || busy ? (
              <LoaderCircle className="spin" />
            ) : (
              <ShieldCheck />
            )}
            {action.mode === "extend"
              ? "Extend subscription"
              : "Record conversion"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function DeletionApprovalDialog({
  item,
  confirmationText,
  workspaceName,
  busy,
  onClose,
  onApprove,
}: {
  item: NonNullable<BootstrapResponse["platform"]>["deletionCases"][number];
  confirmationText: string;
  workspaceName: string;
  busy: boolean;
  onClose: () => void;
  onApprove: (caseId: string, confirmation: string) => Promise<unknown>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={`Approve deletion · ${workspaceName}`}
      eyebrow="Irreversible platform-owner control"
      onClose={onClose}
    >
      <form
        className="modal-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setWorking(true);
          setError("");
          try {
            await onApprove(item.id, confirmation);
            onClose();
          } catch (nextError) {
            setError(messageFromError(nextError));
          } finally {
            setWorking(false);
          }
        }}
      >
        <div className="destructive-warning" role="alert">
          <CircleAlert />
          <span>
            <strong>This queues permanent tenant purge.</strong>
            <small>
              The retention period ended {formatDate(item.eligibleAt, true)}.
              Verify recovery or conversion is no longer required before
              continuing.
            </small>
          </span>
        </div>
        <label className="field">
          <span>Type this exact confirmation phrase</span>
          <code className="confirmation-phrase">{confirmationText}</code>
          <input
            required
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="modal-footer">
          <span />
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button danger-button"
            type="submit"
            disabled={busy || working || confirmation !== confirmationText}
          >
            {working || busy ? <LoaderCircle className="spin" /> : <Trash2 />}
            Approve permanent purge
          </button>
        </footer>
      </form>
    </Modal>
  );
}

const ORGANIZATION_ROLES: Array<{
  value: OrganizationRole;
  label: string;
  description: string;
}> = [
  {
    value: "owner",
    label: "Owner",
    description: "Governance, owners, and all organization settings",
  },
  {
    value: "administrator",
    label: "Administrator",
    description: "Organization identity, domains, and workspace directory",
  },
  {
    value: "billing",
    label: "Billing",
    description: "Commercial terms and usage summaries",
  },
  {
    value: "security_auditor",
    label: "Security auditor",
    description: "Membership and security metadata, without guide content",
  },
];

export function OrganizationView({
  organization,
  busy,
  onAppoint,
  onUpdate,
  onSaveDomains,
  onRevokeAppointment,
}: {
  organization: OrganizationAdministration;
  busy: boolean;
  onAppoint: (
    email: string,
    roles: OrganizationRole[],
    anchorWorkspaceId: string,
  ) => Promise<{
    appointmentId: string;
    appointmentToken: string;
    expiresAt: string;
  }>;
  onUpdate: (
    memberId: string,
    roles: OrganizationRole[],
    status: "active" | "revoked",
  ) => Promise<unknown>;
  onSaveDomains: (domains: string[]) => Promise<unknown>;
  onRevokeAppointment: (appointmentId: string) => Promise<unknown>;
}) {
  const [appointing, setAppointing] = useState(false);
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [domains, setDomains] = useState(organization.domains.join("\n"));
  const [domainsBusy, setDomainsBusy] = useState(false);
  const canManage = organization.roles.includes("owner");
  const editingMember = organization.members.find(
    (member) => member.id === editingMemberId,
  );
  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Organization governance</p>
          <h1>{organization.displayName}</h1>
          <p>
            Govern identity and commercial metadata separately from workspace
            content access. Organization roles never grant guide visibility.
          </p>
        </div>
        {canManage ? (
          <button
            className="button primary"
            type="button"
            disabled={busy || organization.workspaces.length === 0}
            onClick={() => setAppointing(true)}
          >
            <UserPlus /> Appoint organization member
          </button>
        ) : null}
      </div>
      <section className="card settings-card organization-identity-card">
        <div className="settings-title">
          <span style={{ background: organization.branding.accentColor }}>
            <Building2 />
          </span>
          <div>
            <h2>{organization.legalName}</h2>
            <p>
              {organization.country} · {titleCase(organization.status)} · your
              roles: {organization.roles.map(titleCase).join(", ")}
            </p>
          </div>
        </div>
        <p className="privacy-caption">
          <LockKeyhole /> Organization authority is checked from explicit
          membership rows. Email labels and environment variables never grant
          authority.
        </p>
      </section>
      {organization.roles.some((role) =>
        ["owner", "administrator"].includes(role),
      ) ? (
        <section className="card settings-card">
          <div className="settings-title">
            <span>
              <Globe2 />
            </span>
            <div>
              <h2>Approved organization domains</h2>
              <p>
                Domains establish request eligibility only; they never grant
                membership or guide access.
              </p>
            </div>
          </div>
          <label className="field">
            <span>One exact domain per line</span>
            <textarea
              rows={4}
              value={domains}
              onChange={(event) => setDomains(event.target.value)}
              placeholder={"example.com\nsubsidiary.example"}
            />
          </label>
          <p className="privacy-caption">
            <ShieldCheck /> Changes apply consistently to every workspace in
            this organization and require current TOTP verification.
          </p>
          <button
            className="button secondary"
            type="button"
            disabled={busy || domainsBusy}
            onClick={async () => {
              setDomainsBusy(true);
              try {
                await onSaveDomains([
                  ...new Set(
                    domains
                      .split(/\r?\n|,/)
                      .map((item) => item.trim().toLowerCase())
                      .filter(Boolean),
                  ),
                ]);
              } finally {
                setDomainsBusy(false);
              }
            }}
          >
            {domainsBusy ? <LoaderCircle className="spin" /> : <Check />} Save
            organization domains
          </button>
        </section>
      ) : null}
      <section className="card table-card">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Workspace directory</p>
            <h2>{organization.workspaces.length} isolated workspaces</h2>
          </div>
          <ShieldCheck />
        </div>
        {organization.workspaces.map((workspace) => (
          <div className="invite-row" key={workspace.id}>
            <span className="invite-icon">
              <Building2 />
            </span>
            <span className="member-main">
              <strong>{workspace.name}</strong>
              <small>
                {workspace.slug} · organization authority does not open this
                workspace
              </small>
            </span>
            <StatusBadge status={workspace.status} />
          </div>
        ))}
      </section>
      {organization.members.length ? (
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Governance roster</p>
              <h2>{organization.members.length} organization members</h2>
            </div>
            <span className="privacy-caption">
              <ShieldCheck /> Minimum two active owners
            </span>
          </div>
          {organization.members.map((member) => (
            <div className="member-row" key={member.id}>
              <span className="avatar">
                {initials(member.name, member.email)}
              </span>
              <span className="member-main">
                <strong>{member.name || member.email}</strong>
                <small>{member.email}</small>
                <span className="role-chips">
                  {member.roles.map((role) => (
                    <span key={role}>{titleCase(role)}</span>
                  ))}
                </span>
              </span>
              <StatusBadge status={member.status} />
              {canManage ? (
                <button
                  className="button ghost small"
                  type="button"
                  disabled={busy}
                  onClick={() => setEditingMemberId(member.id)}
                >
                  <UserCog /> Edit
                </button>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {organization.appointments.length ? (
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Pending appointments</p>
              <h2>Awaiting verified acceptance</h2>
            </div>
            <Mail />
          </div>
          {organization.appointments.map((appointment) => (
            <div className="invite-row" key={appointment.id}>
              <span className="invite-icon">
                <UserCheck />
              </span>
              <span className="member-main">
                <strong>{appointment.email}</strong>
                <small>Expires {formatDate(appointment.expiresAt, true)}</small>
              </span>
              <button
                className="button ghost small"
                type="button"
                disabled={busy || !canManage}
                onClick={() => {
                  if (
                    window.confirm(
                      `Revoke the appointment for ${appointment.email}?`,
                    )
                  )
                    void onRevokeAppointment(appointment.id);
                }}
              >
                Revoke
              </button>
            </div>
          ))}
        </section>
      ) : null}
      {appointing ? (
        <OrganizationAppointmentDialog
          organization={organization}
          busy={busy}
          onClose={() => setAppointing(false)}
          onAppoint={onAppoint}
        />
      ) : null}
      {editingMember ? (
        <OrganizationMemberDialog
          member={editingMember}
          busy={busy}
          onClose={() => setEditingMemberId(null)}
          onSave={async (roles, status) => {
            await onUpdate(editingMember.id, roles, status);
            setEditingMemberId(null);
          }}
        />
      ) : null}
    </div>
  );
}

function OrganizationAppointmentDialog({
  organization,
  busy,
  onClose,
  onAppoint,
}: {
  organization: OrganizationAdministration;
  busy: boolean;
  onClose: () => void;
  onAppoint: (
    email: string,
    roles: OrganizationRole[],
    anchorWorkspaceId: string,
  ) => Promise<{ appointmentToken: string; expiresAt: string }>;
}) {
  const [email, setEmail] = useState("");
  const [roles, setRoles] = useState<OrganizationRole[]>(["administrator"]);
  const [workspaceId, setWorkspaceId] = useState(
    organization.workspaces[0]?.id ?? "",
  );
  const [credential, setCredential] = useState<{
    token: string;
    expiresAt: string;
  } | null>(null);
  const [error, setError] = useState("");
  const link = credential
    ? `${window.location.origin}/app?appointment=${encodeURIComponent(credential.token)}`
    : "";
  return (
    <Modal
      title="Appoint organization member"
      eyebrow="Email-bound governance role"
      onClose={onClose}
    >
      {credential ? (
        <div className="modal-form created-invite">
          <CheckCircle2 />
          <div>
            <strong>Appointment queued</strong>
            <p>
              The fallback credential is shown once and expires{" "}
              {formatDate(credential.expiresAt, true)}.
            </p>
          </div>
          <div className="copy-field">
            <span>{email.toLowerCase()}</span>
            <input readOnly value={link} />
            <button
              className="button secondary"
              type="button"
              onClick={() => navigator.clipboard.writeText(link)}
            >
              <Copy /> Copy appointment link
            </button>
          </div>
          <footer className="modal-footer">
            <span />
            <button className="button primary" type="button" onClick={onClose}>
              Done
            </button>
          </footer>
        </div>
      ) : (
        <form
          className="modal-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            try {
              const result = await onAppoint(
                email.trim().toLowerCase(),
                roles,
                workspaceId,
              );
              setCredential({
                token: result.appointmentToken,
                expiresAt: result.expiresAt,
              });
            } catch (nextError) {
              setError(messageFromError(nextError));
            }
          }}
        >
          <p className="modal-copy">
            Organization roles expose governance metadata only. Select workspace
            access separately from the workspace Members page.
          </p>
          <label className="field">
            <span>Verified account email</span>
            <input
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <div className="role-picker">
            {ORGANIZATION_ROLES.map((role) => (
              <label className="choice-row" key={role.value}>
                <input
                  type="checkbox"
                  checked={roles.includes(role.value)}
                  onChange={(event) =>
                    setRoles((items) =>
                      event.target.checked
                        ? [...new Set([...items, role.value])]
                        : items.filter((item) => item !== role.value),
                    )
                  }
                />
                <span>
                  <strong>{role.label}</strong>
                  <small>{role.description}</small>
                </span>
              </label>
            ))}
          </div>
          <div className="field">
            <span>Audit anchor workspace</span>
            <SelectMenu
              className="form-select"
              value={workspaceId}
              onChange={setWorkspaceId}
              ariaLabel="Audit anchor workspace"
              options={organization.workspaces.map((workspace) => ({
                value: workspace.id,
                label: workspace.name,
              }))}
            />
            <small>
              This locates the appointment audit event; it does not grant
              workspace access.
            </small>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer className="modal-footer">
            <span />
            <button
              className="button secondary"
              type="button"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={
                busy || !email.includes("@") || !roles.length || !workspaceId
              }
            >
              <UserPlus /> Create appointment
            </button>
          </footer>
        </form>
      )}
    </Modal>
  );
}

function OrganizationMemberDialog({
  member,
  busy,
  onClose,
  onSave,
}: {
  member: OrganizationAdministration["members"][number];
  busy: boolean;
  onClose: () => void;
  onSave: (
    roles: OrganizationRole[],
    status: "active" | "revoked",
  ) => Promise<void>;
}) {
  const [roles, setRoles] = useState(member.roles);
  const [status, setStatus] = useState<"active" | "revoked">(
    member.status === "active" ? "active" : "revoked",
  );
  const [error, setError] = useState("");
  return (
    <Modal
      title={`Organization roles · ${member.name || member.email}`}
      eyebrow="Owner-controlled authority"
      onClose={onClose}
    >
      <form
        className="modal-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            await onSave(roles, status);
          } catch (nextError) {
            setError(messageFromError(nextError));
          }
        }}
      >
        <p className="modal-copy">
          Changing these roles never changes the person&apos;s workspace
          membership or guide audiences. At least two active owners must remain.
        </p>
        <div className="role-picker">
          {ORGANIZATION_ROLES.map((role) => (
            <label className="choice-row" key={role.value}>
              <input
                type="checkbox"
                checked={roles.includes(role.value)}
                onChange={(event) =>
                  setRoles((items) =>
                    event.target.checked
                      ? [...new Set([...items, role.value])]
                      : items.filter((item) => item !== role.value),
                  )
                }
              />
              <span>
                <strong>{role.label}</strong>
                <small>{role.description}</small>
              </span>
            </label>
          ))}
        </div>
        <label className="choice-row emphasized">
          <input
            type="checkbox"
            checked={status === "active"}
            onChange={(event) =>
              setStatus(event.target.checked ? "active" : "revoked")
            }
          />
          <span>
            <strong>Active organization membership</strong>
            <small>
              Revocation takes effect immediately for organization governance.
            </small>
          </span>
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="modal-footer">
          <span />
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || !roles.length}
          >
            <ShieldCheck /> Save roles
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function GlobalGuideSearch({
  guides,
  onOpen,
}: {
  guides: Guide[];
  onOpen: (guide: Guide) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const results = useMemo<GuideSearchResult[] | null>(() => {
    const phrase = query.trim().toLowerCase();
    if (!phrase) return null;
    const terms = [...new Set(phrase.split(/\s+/).filter(Boolean))];

    return guides
      .map((guide) => {
        const revision = guide.workingRevision ?? guide.publishedRevision;
        if (!revision) return null;
        const fields = {
          title: `${revision.title} ${guide.title}`.toLowerCase(),
          summary: revision.summary.toLowerCase(),
          category: revision.category.toLowerCase(),
          tags: revision.tags.join(" ").toLowerCase(),
          steps: revision.steps
            .map((step) => `${step.title} ${step.description}`)
            .join(" ")
            .toLowerCase(),
        };
        const combined = Object.values(fields).join(" ");
        if (!terms.every((term) => combined.includes(term))) return null;

        let score = combined.includes(phrase) ? 20 : 0;
        if (fields.title === phrase) score += 120;
        else if (fields.title.startsWith(phrase)) score += 80;
        else if (fields.title.includes(phrase)) score += 55;
        for (const term of terms) {
          if (fields.title.includes(term)) score += 24;
          if (fields.tags.includes(term)) score += 16;
          if (fields.category.includes(term)) score += 12;
          if (fields.steps.includes(term)) score += 10;
          if (fields.summary.includes(term)) score += 7;
        }

        const excerptFields = [
          revision.summary,
          revision.category,
          ...revision.tags,
          ...revision.steps.flatMap((step) => [step.title, step.description]),
        ].filter(Boolean);
        const excerpt =
          excerptFields.find((field) =>
            field.toLowerCase().includes(terms[0]),
          ) ??
          revision.summary ??
          revision.title;
        return {
          score,
          result: {
            guideId: guide.id,
            revisionId: revision.id,
            title: revision.title || guide.title,
            excerpt: excerpt.slice(0, 180),
            status: guide.status,
            restricted: guide.restricted,
            updatedAt: guide.updatedAt,
          } satisfies GuideSearchResult,
        };
      })
      .filter((item): item is { score: number; result: GuideSearchResult } =>
        Boolean(item),
      )
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.result.updatedAt.localeCompare(a.result.updatedAt),
      )
      .slice(0, 8)
      .map((item) => item.result);
  }, [guides, query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function openResult(result: GuideSearchResult) {
    setOpen(false);
    setQuery("");
    const guide = guides.find((item) => item.id === result.guideId);
    if (guide) onOpen(guide);
  }

  return (
    <div className="global-search" ref={box}>
      <label className="search-field global-search-field">
        <Search />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              setQuery("");
            }
            if (event.key === "Enter" && results?.[0]) {
              event.preventDefault();
              openResult(results[0]);
            }
          }}
          placeholder="Search guides, steps, or tags"
          aria-label="Search guides across this workspace"
        />
      </label>
      {open && query.trim().length ? (
        <div
          className="search-results"
          role="listbox"
          aria-label="Search results"
        >
          {results && results.length === 0 ? (
            <p className="search-empty">
              No guides match &ldquo;{query.trim()}&rdquo; in this workspace.
            </p>
          ) : null}
          {results?.length ? (
            <p className="search-result-count">
              {results.length} best {results.length === 1 ? "match" : "matches"}{" "}
              · press Enter to open the first
            </p>
          ) : null}
          {results?.map((result) => (
            <button
              className="search-result"
              type="button"
              key={`${result.guideId}:${result.revisionId}`}
              onClick={() => openResult(result)}
            >
              <span className="guide-icon">
                <BookOpen />
              </span>
              <span className="search-result-main">
                <span className="guide-title-line">
                  <strong>{result.title}</strong>
                  {result.restricted ? (
                    <span className="restricted-label">
                      <LockKeyhole /> Restricted
                    </span>
                  ) : (
                    <span className="workspace-label">
                      <Globe2 /> Workspace
                    </span>
                  )}
                </span>
                {result.excerpt ? <small>{result.excerpt}</small> : null}
                <span className="guide-meta">
                  <StatusBadge status={result.status} /> Updated{" "}
                  {formatDate(result.updatedAt)}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ExtensionDialog({
  busy,
  companion,
  state,
  onClose,
  onLink,
  onRevoke,
}: {
  busy: boolean;
  companion: ExtensionCompanion;
  state: "checking" | "missing" | "connected";
  onClose: () => void;
  onLink: (options?: { force?: boolean }) => Promise<unknown>;
  onRevoke: () => Promise<void>;
}) {
  const [connectionError, setConnectionError] = useState("");

  async function relink() {
    setConnectionError("");
    try {
      // A revoked or stale credential still reports as connected inside the
      // extension, so an explicit retry always mints a fresh one.
      await onLink({ force: true });
      toast.success("Capture extension connected");
    } catch (error) {
      setConnectionError(messageFromError(error));
    }
  }

  async function revokeDevices() {
    if (
      !window.confirm(
        "Revoke every browser paired by your account in this workspace?",
      )
    )
      return;
    await onRevoke();
    await relink();
  }

  return (
    <Modal
      title="The capture extension"
      eyebrow="Chrome & Edge"
      onClose={onClose}
      wide
    >
      <div className="modal-form">
        <ol className="pairing-steps">
          <li>
            <span>1</span>
            <div>
              <strong>Install the KnowHow extension</strong>
              <p>
                Use your organization&apos;s approved unlisted store listing. Store
                delivery preserves the stable extension ID and automatic updates.
              </p>
              {process.env.NEXT_PUBLIC_KNOWHOW_CHROME_EXTENSION_URL ? (
                <a
                  className="button secondary"
                  href={process.env.NEXT_PUBLIC_KNOWHOW_CHROME_EXTENSION_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Download /> Install for Chrome
                </a>
              ) : null}
              {process.env.NEXT_PUBLIC_KNOWHOW_EDGE_EXTENSION_URL ? (
                <a
                  className="button secondary"
                  href={process.env.NEXT_PUBLIC_KNOWHOW_EDGE_EXTENSION_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Download /> Install for Edge
                </a>
              ) : null}
              {!process.env.NEXT_PUBLIC_KNOWHOW_CHROME_EXTENSION_URL &&
              !process.env.NEXT_PUBLIC_KNOWHOW_EDGE_EXTENSION_URL ? (
                <p className="privacy-caption">
                  Development only: run the validated extension build and load
                  <code> extension/dist </code> through browser developer mode.
                </p>
              ) : null}
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Nothing to pair</strong>
              <p>
                Because you are signed in here, KnowHow hands this workspace to
                the installed extension by itself. There is no code to copy and
                no button to press.
              </p>
              {state === "checking" ? (
                <button className="button primary" disabled>
                  <LoaderCircle className="spin" /> Checking extension
                </button>
              ) : state === "missing" ? (
                <button
                  className="button primary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void relink();
                  }}
                >
                  <Link2 /> Retry connection
                </button>
              ) : (
                <span className="extension-connected">
                  <CheckCircle2 /> Connected to {companion.workspaceName}
                </span>
              )}
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Capture and follow guides side by side</strong>
              <p>
                The side panel records your clicks and reads your guides with
                their screenshots, blur regions, and click markers intact.
              </p>
              <button
                className="button ghost small"
                type="button"
                disabled={busy}
                onClick={() => {
                  void revokeDevices().catch(() => undefined);
                }}
              >
                <Trash2 /> Revoke browser access
              </button>
            </div>
          </li>
        </ol>
        {state === "missing" ? (
          <p className="form-error">
            KnowHow could not reach the extension. Install or reload it, then
            retry.
          </p>
        ) : null}
        {connectionError ? (
          <p className="form-error" role="alert">
            {connectionError}
          </p>
        ) : null}
        <p className="privacy-caption">
          <ShieldCheck /> Connection, capture uploads, and device revocation are
          audited for workspace administrators.
        </p>
        <footer className="modal-footer">
          <span />
          <button className="button primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </Modal>
  );
}

function AccountSecurityDialog({ onClose }: { onClose: () => void }) {
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  async function regenerate() {
    setWorking(true);
    setError("");
    try {
      const result = await regenerateMfaRecoveryCodes();
      if (!result.recoveryCodes?.length) {
        throw new Error("No recovery codes were returned.");
      }
      setRecoveryCodes(result.recoveryCodes);
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal
      title="Account security"
      eyebrow="Authenticator recovery"
      onClose={onClose}
    >
      <div className="modal-form">
        {recoveryCodes.length ? (
          <div className="created-invite">
            <ShieldCheck />
            <div>
              <strong>New recovery codes</strong>
              <p>
                These codes replace every previous recovery code and are shown
                once. Store them in a password manager now.
              </p>
            </div>
            <ol className="mfa-recovery-codes" aria-label="New recovery codes">
              {recoveryCodes.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                </li>
              ))}
            </ol>
            <button
              className="button secondary"
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(recoveryCodes.join("\n"))
                  .then(() => toast.success("Recovery codes copied"));
              }}
            >
              <Copy /> Copy codes
            </button>
          </div>
        ) : (
          <>
            <p className="modal-copy">
              Generate a replacement set if your saved codes are unavailable.
              You will confirm a current authenticator code before KnowHow
              replaces them.
            </p>
            <p className="privacy-caption">
              <LockKeyhole /> KnowHow shows recovery codes only once and never
              includes them in logs, email, or support records.
            </p>
          </>
        )}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="modal-footer">
          <span />
          <button className="button secondary" type="button" onClick={onClose}>
            {recoveryCodes.length ? "I saved the codes" : "Cancel"}
          </button>
          {!recoveryCodes.length ? (
            <button
              className="button primary"
              type="button"
              disabled={working}
              onClick={() => void regenerate()}
            >
              {working ? <LoaderCircle className="spin" /> : <RotateCcw />} Regenerate
              codes
            </button>
          ) : null}
        </footer>
      </div>
    </Modal>
  );
}

function RouteUnavailable({ onBack }: { onBack: () => void }) {
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);
  useEffect(() => {
    const timeout = window.setTimeout(() => onBackRef.current(), 350);
    return () => window.clearTimeout(timeout);
  }, []);

  return (
    <main className="route-unavailable" role="status" aria-live="polite">
      <span className="opening-mark">K</span>
      <h1>This page is unavailable</h1>
      <p>Redirecting you to available guides.</p>
      <button className="button primary" type="button" onClick={onBack}>
        Open available guides
      </button>
    </main>
  );
}

export function KnowHowWorkspaceApp({
  data,
  activeWorkspaceId,
  route,
  busy,
  globalError,
  onSelectWorkspace,
  onRefresh,
  onSignOut,
  onBusyChange,
  onError,
  onNavigate,
  onRegisterNavigationGuard,
}: {
  data: BootstrapResponse;
  activeWorkspaceId: string;
  route: AppRoute;
  busy: boolean;
  globalError: string;
  onSelectWorkspace: (id: string) => Promise<void>;
  onRefresh: () => Promise<BootstrapResponse>;
  onSignOut: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string) => void;
  onNavigate: (href: string, options?: { replace?: boolean }) => void;
  onRegisterNavigationGuard: (guard: NavigationGuard | null) => void;
}) {
  const active = data.activeWorkspace!;
  const {
    workspace,
    guides,
    groups,
    members,
    invitations,
    supportRequests,
    supportGrants,
    supportTickets,
  } = active;
  const vaultItems = active.vaultItems ?? [];
  const pendingSupportCount = supportRequests.filter(
    (item) => item.status === "pending",
  ).length;
  const [dialog, setDialog] = useState<DialogState>(null);
  const { resolvedTheme, setPreference } = useTheme();
  const roles = workspace.roles;
  const isAdmin = roles.includes("administrator");
  const canCreate = isAdmin || roles.includes("creator");
  const workspaceMutable =
    workspace.status === "active" &&
    workspace.subscription?.access !== "read_only";
  const canCapture = canCreate && workspaceMutable;
  const currentMember = members.find(
    (member) => member.userId === data.viewer.id,
  );
  const canUseVault = currentMember?.capabilities?.includes("vault") ?? false;
  const organization = data.organizations?.find(
    (item) => item.id === workspace.organizationId,
  );
  const view: View =
    route.kind === "platform"
      ? "Platform"
      : route.kind === "workspace-section"
        ? SECTION_TO_VIEW[route.section]
        : route.kind === "guide-new" ||
            route.kind === "guide-view" ||
            route.kind === "guide-edit"
          ? "Guides"
          : "Overview";

  const [extensionLink, setExtensionLink] = useState<
    "checking" | "missing" | "connected"
  >("checking");
  const extensionCompanion = useMemo<ExtensionCompanion>(
    () => ({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      userName: data.viewer.name || data.viewer.email,
      theme: resolvedTheme === "dark" ? "dark" : "light",
      guides: guides.flatMap((guide) => {
        const revision = guide.publishedRevision ?? guide.workingRevision;
        if (!revision) return [];
        const mode = guide.publishedRevision ? "published" : "working";
        return [
          {
            id: guide.id,
            title: revision.title || guide.title,
            summary: revision.summary,
            status: guide.status,
            restricted: guide.restricted,
            updatedAt: guide.updatedAt,
            href: guideHref(workspace.slug, guide.id, mode),
            steps: revision.steps.map((step) => {
              const click = step.annotations?.find(
                (annotation) => annotation.kind === "click",
              );
              const pendingRedactions = (step.redactions ?? []).filter(
                (region) => !region.applied,
              );
              return {
                id: step.id,
                kind: step.kind,
                title: step.title,
                description: step.description,
                ...(step.screenshotMediaId
                  ? {
                      media: {
                        mediaId: step.screenshotMediaId,
                        ...(step.crop ? { crop: step.crop } : {}),
                        ...(click
                          ? {
                              click: {
                                x: click.x,
                                y: click.y,
                                radius: click.width ?? 0.035,
                                ...(click.color ? { color: click.color } : {}),
                              },
                            }
                          : {}),
                        ...(pendingRedactions.length
                          ? {
                              redactions: pendingRedactions.map((region) => ({
                                x: region.x,
                                y: region.y,
                                width: region.width,
                                height: region.height,
                              })),
                            }
                          : {}),
                      },
                    }
                  : {}),
              };
            }),
          },
        ];
      }),
    }),
    [
      data.viewer.email,
      data.viewer.name,
      guides,
      resolvedTheme,
      workspace.id,
      workspace.name,
      workspace.slug,
    ],
  );

  // The extension is handed the signed-in workspace automatically: being in the
  // app is the proof of identity, so nobody copies a pairing code. Credentials
  // are minted only when the installed extension is not already holding this
  // workspace, which keeps repeat visits to a single ping.
  const linkExtension = useCallback(
    async (options: { force?: boolean } = {}) => {
      const state = await ensureKnowHowExtension(
        extensionCompanion,
        () =>
          knowhowCommand<{ code: string; expiresAt: string }>(
            "createPairingCode",
            {
              workspaceId: workspace.id,
            },
          ),
        options,
      );
      setExtensionLink(state.installed ? "connected" : "missing");
      return state;
    },
    [extensionCompanion, workspace.id],
  );

  useEffect(() => {
    const link = () => {
      const attempt = canCapture
        ? linkExtension()
        : syncKnowHowExtension(extensionCompanion).then(() =>
            setExtensionLink("connected"),
          );
      void attempt.catch(() => setExtensionLink("missing"));
    };
    link();
    window.addEventListener("focus", link);
    return () => window.removeEventListener("focus", link);
  }, [canCapture, extensionCompanion, linkExtension]);

  const recordPublishedView = useCallback(
    (guide: Guide) => {
      if (!guide.publishedRevision) return;
      void knowhowCommand("recordGuideView", {
        workspaceId: workspace.id,
        guideId: guide.id,
      }).catch(() => undefined);
    },
    [workspace.id],
  );

  const openGuide = useCallback(
    (guide: Guide, initialRevision?: "working" | "published") => {
      const resolved =
        initialRevision ?? (guide.workingRevision ? "working" : "published");
      onNavigate(guideHref(workspace.slug, guide.id, resolved));
      if (resolved === "published") recordPublishedView(guide);
    },
    [onNavigate, recordPublishedView, workspace.slug],
  );

  useEffect(() => {
    const scopedKey = `knowhow-theme:${data.viewer.id}`;
    const stored = window.localStorage.getItem(scopedKey);
    const next =
      stored === "light" || stored === "dark" || stored === "system"
        ? stored
        : (data.viewer.themePreference ?? "system");
    const frame = window.requestAnimationFrame(() => setPreference(next));
    return () => window.cancelAnimationFrame(frame);
  }, [data.viewer.id, data.viewer.themePreference, setPreference]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setDialog(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [workspace.id]);

  async function command<T = unknown>(
    action: string,
    payload: unknown,
    success: string,
  ) {
    onBusyChange(true);
    onError("");
    try {
      const result = await knowhowCommand<T>(action, {
        workspaceId: workspace.id,
        ...((payload ?? {}) as object),
      });
      await onRefresh();
      if (success) toast.success(success);
      return result;
    } catch (error) {
      onError(messageFromError(error));
      throw error;
    } finally {
      onBusyChange(false);
    }
  }

  async function saveGuide(payload: GuideEditorPayload) {
    return command<GuideSaveResult>(
      "saveGuide",
      payload,
      payload.transition === "review"
        ? "Draft sent for review"
        : "Private draft saved",
    );
  }

  function navigateToView(nextView: View) {
    const href =
      nextView === "Platform"
        ? platformHref()
        : workspaceHref(workspace.slug, VIEW_TO_SECTION[nextView]);
    onNavigate(href);
  }

  const routeGuideId =
    route.kind === "guide-view" || route.kind === "guide-edit"
      ? route.guideId
      : null;
  const routeGuide = routeGuideId
    ? (guides.find((guide) => guide.id === routeGuideId) ?? null)
    : null;
  const isGuideEditorRoute =
    route.kind === "guide-new" || route.kind === "guide-edit";
  const isGuideReaderRoute = route.kind === "guide-view";
  const canAccessCurrentView =
    view !== "Platform"
      ? !(view === "Vault" && !canUseVault) &&
        !(["Groups", "Members", "Settings"].includes(view) && !isAdmin) &&
        !(view === "Organization" && !organization)
      : data.viewer.platformAdministrator;
  const publishedRestricted = Boolean(
    routeGuide?.publishedRevision &&
      !routeGuide.publishedRevision.audiences.some(
        (item) => item.kind === "workspace",
      ),
  );
  const routeGuideAuthor =
    routeGuide?.workingRevision?.authorId ??
    routeGuide?.publishedRevision?.authorId;
  const canRestoreRouteGuide = Boolean(
    workspaceMutable &&
      routeGuide &&
      (isAdmin ||
        (roles.includes("creator") && routeGuideAuthor === data.viewer.id)),
  );
  const publishedViewKey = useRef("");

  useEffect(() => {
    if (
      !isGuideReaderRoute ||
      !routeGuide ||
      route.kind !== "guide-view" ||
      route.revision !== "published"
    )
      return;
    const key = `${workspace.id}:${routeGuide.id}:${route.revision}`;
    if (publishedViewKey.current === key) return;
    publishedViewKey.current = key;
    recordPublishedView(routeGuide);
  }, [
    isGuideReaderRoute,
    recordPublishedView,
    route,
    routeGuide,
    workspace.id,
  ]);

  const visibleNav = [
    ...NAV_ITEMS.filter((item) => {
      if (item.view === "Vault") return canUseVault;
      if (item.view === "Organization") return Boolean(organization);
      if (["Groups", "Members", "Settings"].includes(item.view)) return isAdmin;
      return true;
    }),
    ...(data.viewer.platformAdministrator
      ? [{ view: "Platform" as const, icon: Shield }]
      : []),
  ];
  const workspaceNavigation = visibleNav.filter(({ view: item }) =>
    ["Overview", "Guides", "Capture", "Support"].includes(item),
  );
  const governanceNavigation = visibleNav.filter(
    ({ view: item }) =>
      !["Overview", "Guides", "Capture", "Support"].includes(item),
  );

  if (!canAccessCurrentView) {
    return (
      <RouteUnavailable
        onBack={() =>
          onNavigate(workspaceHref(workspace.slug, "guides"), { replace: true })
        }
      />
    );
  }

  if (isGuideEditorRoute) {
    const editorGuide = route.kind === "guide-edit" ? routeGuide : null;
    const canEdit =
      workspaceMutable && (editorGuide ? editorGuide.canEdit : canCreate);
    if (!canEdit || (route.kind === "guide-edit" && !editorGuide)) {
      return (
        <RouteUnavailable
          onBack={() =>
            onNavigate(workspaceHref(workspace.slug, "guides"), {
              replace: true,
            })
          }
        />
      );
    }
    return (
      <div
        className="focused-guide-route"
        style={
          {
            "--workspace-accent": workspace.settings.accentColor,
            "--click-color": workspace.settings.clickTargetColor,
          } as React.CSSProperties
        }
      >
        <GuideEditor
          key={editorGuide?.id ?? "new"}
          guide={editorGuide}
          workspace={workspace}
          groups={groups}
          members={members}
          busy={busy || !workspaceMutable}
          onClose={() => onNavigate(workspaceHref(workspace.slug, "guides"))}
          onSave={saveGuide}
          onSaved={(result, transition) => {
            if (!editorGuide) {
              onNavigate(guideEditorHref(workspace.slug, result.guideId), {
                replace: true,
              });
              return;
            }
            if (transition === "review") {
              onNavigate(guideHref(workspace.slug, result.guideId, "working"), {
                replace: true,
              });
            }
          }}
          onMediaChanged={onRefresh}
          onDelete={
            editorGuide?.canDelete
              ? async () => {
                  await command(
                    "deleteGuide",
                    { guideId: editorGuide.id },
                    "Guide deleted",
                  );
                  onNavigate(workspaceHref(workspace.slug, "guides"), {
                    replace: true,
                  });
                }
              : undefined
          }
          onRegisterNavigationGuard={onRegisterNavigationGuard}
        />
        {busy ? (
          <div className="busy-indicator" role="status">
            <LoaderCircle className="spin" /> Working securely…
          </div>
        ) : null}
      </div>
    );
  }

  if (isGuideReaderRoute) {
    if (!routeGuide || route.kind !== "guide-view") {
      return (
        <RouteUnavailable
          onBack={() =>
            onNavigate(workspaceHref(workspace.slug, "guides"), {
              replace: true,
            })
          }
        />
      );
    }
    return (
      <div
        className="focused-guide-route"
        style={
          {
            "--workspace-accent": workspace.settings.accentColor,
            "--click-color": workspace.settings.clickTargetColor,
          } as React.CSSProperties
        }
      >
        <GuideViewer
          guide={routeGuide}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          logoKey={workspace.settings.logoUrl}
          accentColor={workspace.settings.accentColor}
          clickTargetColor={workspace.settings.clickTargetColor}
          initialRevision={route.revision}
          liveUrl={`${window.location.origin}${guideHref(workspace.slug, routeGuide.id, "published")}`}
          canExport={
            Boolean(routeGuide.publishedRevision) &&
            (!publishedRestricted || workspace.settings.allowRestrictedExports)
          }
          canRestore={canRestoreRouteGuide}
          busy={busy || !workspaceMutable}
          onClose={() => onNavigate(workspaceHref(workspace.slug, "guides"))}
          onEdit={() =>
            onNavigate(guideEditorHref(workspace.slug, routeGuide.id))
          }
          onDelete={
            routeGuide.canDelete
              ? async () => {
                  await command(
                    "deleteGuide",
                    { guideId: routeGuide.id },
                    "Guide deleted",
                  );
                  onNavigate(workspaceHref(workspace.slug, "guides"), {
                    replace: true,
                  });
                }
              : undefined
          }
          onRevisionChange={(revision) =>
            onNavigate(guideHref(workspace.slug, routeGuide.id, revision), {
              replace: true,
            })
          }
          onPublishedViewed={() => recordPublishedView(routeGuide)}
          onComplete={() => {
            void command(
              "recordGuideCompletion",
              { guideId: routeGuide.id },
              "Guide marked complete",
            ).catch(() => undefined);
          }}
          onExport={async (format) => {
            onBusyChange(true);
            onError("");
            try {
              await downloadAuthorizedExport(
                workspace.id,
                routeGuide.id,
                format,
              );
              toast.success(`${format.toUpperCase()} export created`);
              await onRefresh();
            } catch (error) {
              onError(messageFromError(error));
            } finally {
              onBusyChange(false);
            }
          }}
          onRestore={(revisionId) => {
            void command(
              "restoreRevision",
              { guideId: routeGuide.id, revisionId },
              "Revision restored as a private draft",
            )
              .then(() =>
                onNavigate(guideEditorHref(workspace.slug, routeGuide.id), {
                  replace: true,
                }),
              )
              .catch(() => undefined);
          }}
        />
        {busy ? (
          <div className="busy-indicator" role="status">
            <LoaderCircle className="spin" /> Working securely…
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <SidebarProvider>
      <div
        className="app-shell"
        style={
          {
            "--workspace-accent": workspace.settings.accentColor,
            "--click-color": workspace.settings.clickTargetColor,
          } as React.CSSProperties
        }
      >
        <Sidebar className="sidebar" collapsible="offcanvas">
          <SidebarHeader className="workspace-sidebar-header">
            <div className="sidebar-brand">
              <ProductBrand compact />
            </div>
            <p className="sidebar-section-label">Active workspace</p>
            <SelectMenu
              className="workspace-menu"
              contentClassName="workspace-menu-options"
              value={activeWorkspaceId}
              disabled={busy}
              onChange={(value) => void onSelectWorkspace(value)}
              ariaLabel="Switch workspace"
              options={data.workspaces.map((item) => ({
                value: item.id,
                label: item.name,
              }))}
              renderValue={() => (
                <>
                  <WorkspaceLogo
                    workspaceId={workspace.id}
                    workspaceName={workspace.name}
                    logoKey={workspace.settings.logoUrl}
                    size="md"
                  />
                  <span className="workspace-menu-copy">
                    <strong>{workspace.name}</strong>
                    <small>{roles.map(titleCase).join(" · ")}</small>
                  </span>
                </>
              )}
            />
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup className="workspace-nav-group">
              <p className="sidebar-section-label">Workspace</p>
              <nav className="main-nav" aria-label="Workspace navigation">
                <SidebarMenu>
                  {workspaceNavigation.map(({ view: item, icon: Icon }) => (
                    <SidebarMenuItem key={item}>
                      <SidebarMenuButton
                        isActive={view === item}
                        type="button"
                        onClick={() => navigateToView(item)}
                      >
                        <Icon />
                        <span>{item}</span>
                      </SidebarMenuButton>
                      {item === "Guides" && active.metrics.reviews ? (
                        <SidebarMenuBadge>
                          {active.metrics.reviews}
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </nav>
            </SidebarGroup>
            {governanceNavigation.length ? (
              <SidebarGroup className="workspace-nav-group governance-nav-group">
                <p className="sidebar-section-label">Governance</p>
                <nav className="main-nav" aria-label="Governance navigation">
                  <SidebarMenu>
                    {governanceNavigation.map(({ view: item, icon: Icon }) => (
                      <SidebarMenuItem key={item}>
                        <SidebarMenuButton
                          isActive={view === item}
                          type="button"
                          onClick={() => navigateToView(item)}
                        >
                          <Icon />
                          <span>{item}</span>
                        </SidebarMenuButton>
                        {item === "Members" && pendingSupportCount ? (
                          <SidebarMenuBadge className="nav-badge">
                            {pendingSupportCount}
                          </SidebarMenuBadge>
                        ) : null}
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </nav>
              </SidebarGroup>
            ) : null}
          </SidebarContent>
          <SidebarFooter>
            <button
              className="capture-shortcut"
              type="button"
              disabled={!canCapture}
              onClick={() => setDialog({ type: "extension" })}
            >
              <span>
                <Sparkles />
              </span>
              <span>
                <strong>Capture workflow</strong>
                <small>
                  {canCapture
                    ? "Chrome & Edge extension"
                    : "Creator access required"}
                </small>
              </span>
              <ArrowRight />
            </button>
          </SidebarFooter>
        </Sidebar>

        <div className="app-main">
          <header className="topbar">
            <div className="topbar-start">
              <SidebarTrigger className="mobile-menu" />
              <div className="topbar-workspace">
                <WorkspaceLogo
                  workspaceId={workspace.id}
                  workspaceName={workspace.name}
                  logoKey={workspace.settings.logoUrl}
                  size="sm"
                />
                <span>
                  <small>Workspace</small>
                  <strong>{workspace.name}</strong>
                </span>
              </div>
            </div>
            <div className="topbar-search-slot">
              <GlobalGuideSearch guides={guides} onOpen={openGuide} />
            </div>
            <div className="topbar-actions">
              <Button
                className="theme-toggle"
                variant="outline"
                size="icon-sm"
                type="button"
                aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
                title={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
                onClick={() => {
                  const theme = resolvedTheme === "dark" ? "light" : "dark";
                  window.localStorage.setItem(
                    `knowhow-theme:${data.viewer.id}`,
                    theme,
                  );
                  setPreference(theme);
                  void knowhowCommand("updateTheme", { theme }).catch((error) =>
                    onError(messageFromError(error)),
                  );
                }}
              >
                {resolvedTheme === "dark" ? <Sun /> : <Moon />}
              </Button>
              <Button
                className="top-create"
                size="sm"
                type="button"
                disabled={
                  busy ||
                  (view === "Platform"
                    ? !data.viewer.platformAdministrator
                    : !canCreate || !workspaceMutable)
                }
                onClick={() =>
                  view === "Platform"
                    ? setDialog({ type: "platform-create" })
                    : onNavigate(newGuideHref(workspace.slug))
                }
              >
                <Plus /> {view === "Platform" ? "Organization" : "Create"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="profile-button"
                  aria-label="Open account menu"
                >
                  <span className="avatar">
                    {initials(data.viewer.name, data.viewer.email)}
                  </span>
                  <span>
                    <strong>{data.viewer.name}</strong>
                    <small>{data.viewer.email}</small>
                  </span>
                  <ChevronDown />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="profile-menu">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>
                      <strong>{data.viewer.name}</strong>
                      <small>{data.viewer.email}</small>
                    </DropdownMenuLabel>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setDialog({ type: "account-security" })}
                  >
                    <KeyRound /> Account security
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onSignOut}>
                    <LogOut /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          {workspace.status !== "active" ? (
            <div className="suspension-banner">
              <CircleAlert />
              <span>
                This workspace is {workspace.status}. Changes and captures are
                disabled until a platform administrator restores it.
              </span>
            </div>
          ) : null}
          {workspace.subscription?.access === "read_only" ? (
            <div className="suspension-banner">
              <CircleAlert />
              <span>
                The subscription has expired and is in read-only grace until{" "}
                {workspace.subscription.graceEndsAt
                  ? formatDate(workspace.subscription.graceEndsAt, true)
                  : "the configured grace deadline"}
                . Viewing, exports, account access, and settings inspection
                remain available; changes and captures are disabled.
              </span>
            </div>
          ) : null}
          {globalError ? (
            <div className="global-error" role="alert">
              <CircleAlert />
              <span>{globalError}</span>
              <button className="icon-button" onClick={() => onError("")}>
                <X />
              </button>
            </div>
          ) : null}
          <main className="content-area">
            {view === "Overview" ? (
              <OverviewView
                data={active}
                viewerName={data.viewer.name}
                canCreate={canCreate && workspaceMutable}
                canCapture={canCapture}
                canManageAccess={isAdmin}
                busy={busy}
                onNewGuide={() => onNavigate(newGuideHref(workspace.slug))}
                onOpenGuide={(guide) => openGuide(guide)}
                onNavigate={navigateToView}
                onConfirmReadiness={() =>
                  command(
                    "confirmOnboardingReadiness",
                    {
                      ordinaryDataOnly: true,
                      pilotPoliciesReviewed: true,
                    },
                    "Pilot workspace readiness confirmed",
                  ).then(() => undefined)
                }
              />
            ) : null}
            {view === "Guides" ? (
              <GuidesView
                guides={guides}
                canCreate={canCreate && workspaceMutable}
                onNew={() => onNavigate(newGuideHref(workspace.slug))}
                onOpen={(guide) => openGuide(guide)}
                onEdit={(guide) =>
                  onNavigate(guideEditorHref(workspace.slug, guide.id))
                }
                onAction={command}
                busy={busy || !workspaceMutable}
              />
            ) : null}
            {view === "Capture" ? (
              <CaptureView
                canCapture={canCapture}
                onOpenExtension={() => setDialog({ type: "extension" })}
              />
            ) : null}
            {view === "Groups" && isAdmin ? (
              <GroupsView
                groups={groups}
                busy={busy || !workspaceMutable}
                onNew={() => setDialog({ type: "group", group: null })}
                onEdit={(group) => setDialog({ type: "group", group })}
              />
            ) : null}
            {view === "Members" && isAdmin ? (
              <MembersView
                members={members}
                invitations={invitations}
                supportRequests={supportRequests}
                supportGrants={supportGrants}
                busy={busy || !workspaceMutable}
                onInvite={() => setDialog({ type: "invite" })}
                onEdit={(member) => setDialog({ type: "member", member })}
                onRevoke={(invitationId) => {
                  void command(
                    "revokeInvite",
                    { invitationId },
                    "Invitation revoked",
                  ).catch(() => undefined);
                }}
                onResolveSupport={(request) =>
                  setDialog({ type: "support-decision", request })
                }
                onRevokeSupport={(grant) => {
                  if (
                    window.confirm(
                      `Revoke ${grant.displayName || grant.email}'s temporary access now?`,
                    )
                  )
                    void command(
                      "revokeSupportAccess",
                      { grantId: grant.id },
                      "Temporary support access revoked",
                    ).catch(() => undefined);
                }}
              />
            ) : null}
            {view === "Vault" && canUseVault ? (
              <VaultView
                items={vaultItems}
                busy={busy || !workspaceMutable}
                onNew={() => setDialog({ type: "vault-editor", item: null })}
                onEdit={(item) => setDialog({ type: "vault-editor", item })}
                onReveal={(item) => setDialog({ type: "vault-reveal", item })}
                onDelete={(item) => {
                  if (
                    window.confirm(
                      `Delete ${item.title}? This encrypted item cannot be recovered.`,
                    )
                  )
                    void command(
                      "deleteVaultItem",
                      { vaultItemId: item.id },
                      "Vault item deleted",
                    ).catch(() => undefined);
                }}
              />
            ) : null}
            {view === "Support" ? (
              <SupportView
                tickets={supportTickets}
                busy={busy || !workspaceMutable}
                onCreate={async (subject, message) => {
                  await command(
                    "createSupportTicket",
                    { subject, message },
                    "Support ticket opened",
                  );
                }}
                onReply={async (ticketId, message) => {
                  await command(
                    "replySupportTicket",
                    { ticketId, message },
                    "Reply sent",
                  );
                }}
                onClose={async (ticketId) => {
                  await command(
                    "closeSupportTicket",
                    { ticketId },
                    "Support ticket closed",
                  );
                }}
              />
            ) : null}
            {view === "Organization" && organization ? (
              <OrganizationView
                organization={organization}
                busy={busy}
                onAppoint={(email, roles, anchorWorkspaceId) =>
                  command<{
                    appointmentId: string;
                    appointmentToken: string;
                    expiresAt: string;
                  }>(
                    "appointOrganizationMember",
                    {
                      organizationId: organization.id,
                      email,
                      roles,
                      anchorWorkspaceId,
                    },
                    "Organization appointment created",
                  )
                }
                onUpdate={(memberId, roles, status) =>
                  command(
                    "updateOrganizationMember",
                    {
                      organizationId: organization.id,
                      memberId,
                      roles,
                      status,
                    },
                    "Organization membership updated",
                  )
                }
                onSaveDomains={(domains) =>
                  command(
                    "updateOrganizationDomains",
                    { organizationId: organization.id, domains },
                    "Organization domains updated",
                  )
                }
                onRevokeAppointment={(appointmentId) =>
                  command(
                    "revokeAppointment",
                    { appointmentId },
                    "Appointment revoked",
                  )
                }
              />
            ) : null}
            {view === "Settings" && isAdmin ? (
              <SettingsView
                key={workspace.id}
                workspaceId={workspace.id}
                workspaceName={workspace.name}
                initial={workspace.settings}
                busy={busy || !workspaceMutable}
                canManageDomains={Boolean(
                  organization?.roles.some((role) =>
                    ["owner", "administrator"].includes(role),
                  ),
                )}
                onRefresh={onRefresh}
                onSave={async (settings) => {
                  await command(
                    "updateWorkspaceSettings",
                    { settings },
                    "Workspace policies saved",
                  );
                }}
                onSaveDomains={async (allowedDomains) => {
                  await command(
                    "updateAllowedDomains",
                    { allowedDomains },
                    "Approved domains saved",
                  );
                }}
              />
            ) : null}
            {view === "Platform" &&
            data.viewer.platformAdministrator &&
            data.platform ? (
              <PlatformView
                platform={data.platform}
                busy={busy}
                onProvision={() => setDialog({ type: "platform-create" })}
                onStatus={(workspaceId, status) => {
                  if (window.confirm(`${titleCase(status)} this workspace?`))
                    void command(
                      "setWorkspaceStatus",
                      { targetWorkspaceId: workspaceId, status },
                      `Workspace ${status}`,
                    ).catch(() => undefined);
                }}
                onAssign={(target) =>
                  setDialog({ type: "assign-admin", workspace: target })
                }
                onRequestSupport={(target) =>
                  setDialog({ type: "support-request", workspace: target })
                }
                onExtendSubscription={async (
                  targetWorkspaceId,
                  expiresAt,
                  graceDays,
                  retentionDays,
                ) => {
                  return command(
                    "extendSubscription",
                    {
                      targetWorkspaceId,
                      expiresAt,
                      graceDays,
                      retentionDays,
                    },
                    "Subscription extended",
                  );
                }}
                onConvertSubscription={async (
                  targetWorkspaceId,
                  manualReference,
                  expiresAt,
                ) => {
                  return command(
                    "convertSubscription",
                    { targetWorkspaceId, manualReference, expiresAt },
                    "Manual contract recorded",
                  );
                }}
                onApproveDeletion={async (caseId, confirmation) => {
                  return command(
                    "approveDeletionCase",
                    { caseId, confirmation },
                    "Tenant purge approved",
                  );
                }}
                onRevokeAppointment={(appointment) => {
                  if (
                    window.confirm(
                      `Revoke the administrator appointment for ${appointment.email}?`,
                    )
                  )
                    void command(
                      "revokeAppointment",
                      { appointmentId: appointment.id },
                      "Appointment revoked",
                    ).catch(() => undefined);
                }}
              />
            ) : null}
          </main>
        </div>

        {dialog?.type === "group" && isAdmin && workspaceMutable ? (
          <GroupDialog
            group={dialog.group}
            members={members}
            busy={busy}
            onClose={() => setDialog(null)}
            onSave={async (payload) => {
              await command(
                "saveGroup",
                payload,
                payload.id ? "Group updated" : "Group created",
              );
              setDialog(null);
            }}
            onDelete={async (groupId) => {
              await command("deleteGroup", { groupId }, "Group deleted");
              setDialog(null);
            }}
          />
        ) : null}
        {dialog?.type === "member" && isAdmin && workspaceMutable ? (
          <MemberDialog
            member={dialog.member}
            busy={busy}
            onClose={() => setDialog(null)}
            onSave={async (nextRoles, capabilities) => {
              await command(
                "updateMember",
                {
                  memberId: dialog.member.id,
                  roles: nextRoles,
                  capabilities,
                  status: dialog.member.status,
                },
                "Member access updated",
              );
              setDialog(null);
            }}
            onSuspend={async () => {
              await command(
                "updateMember",
                {
                  memberId: dialog.member.id,
                  roles: dialog.member.roles,
                  capabilities: dialog.member.capabilities ?? [],
                  status:
                    dialog.member.status === "suspended"
                      ? "active"
                      : "suspended",
                },
                dialog.member.status === "suspended"
                  ? "Member restored"
                  : "Member suspended",
              );
              setDialog(null);
            }}
          />
        ) : null}
        {dialog?.type === "invite" && isAdmin && workspaceMutable ? (
          <InviteDialog
            busy={busy}
            origin={window.location.origin}
            onClose={() => setDialog(null)}
            onCreate={(payload) =>
              command<{ token: string }>(
                "createInvite",
                payload,
                "Invitation created",
              )
            }
          />
        ) : null}
        {dialog?.type === "extension" && canCapture ? (
          <ExtensionDialog
            busy={busy}
            companion={extensionCompanion}
            state={extensionLink}
            onClose={() => setDialog(null)}
            onLink={linkExtension}
            onRevoke={() =>
              command(
                "revokeCaptureDevices",
                {},
                "Paired browser access revoked",
              )
            }
          />
        ) : null}
        {dialog?.type === "platform-create" &&
        data.viewer.platformAdministrator ? (
          <PlatformProvisioningDialog
            busy={busy}
            initialRun={data.platform?.provisioningRuns[0]}
            onClose={() => setDialog(null)}
            onSave={(runId, step, stepData) =>
              command(
                "saveProvisioningRun",
                { ...(runId ? { runId } : {}), step, data: stepData },
                "",
              )
            }
            onComplete={(runId) =>
              command<PlatformProvisioningResult>(
                "completeProvisioningRun",
                { runId },
                "Organization provisioned",
              )
            }
          />
        ) : null}
        {dialog?.type === "assign-admin" &&
        data.viewer.platformAdministrator ? (
          <AssignAdminDialog
            workspace={dialog.workspace}
            busy={busy}
            onClose={() => setDialog(null)}
            onAssign={async (email) => {
              await command(
                "assignWorkspaceAdministrator",
                { targetWorkspaceId: dialog.workspace.id, email },
                "Workspace administrator assigned",
              );
              setDialog(null);
            }}
          />
        ) : null}
        {dialog?.type === "support-request" &&
        data.viewer.platformAdministrator ? (
          <SupportRequestDialog
            workspace={dialog.workspace}
            busy={busy}
            onClose={() => setDialog(null)}
            onRequest={async (
              requestedRole,
              reason,
              requestedDurationHours,
            ) => {
              await command(
                "requestSupportAccess",
                {
                  workspaceId: dialog.workspace.id,
                  requestedRole,
                  reason,
                  requestedDurationHours,
                },
                "Support request submitted for approval",
              );
              setDialog(null);
            }}
          />
        ) : null}
        {dialog?.type === "support-decision" && isAdmin ? (
          <SupportDecisionDialog
            request={dialog.request}
            busy={busy}
            onClose={() => setDialog(null)}
            onDecide={async (
              approve,
              grantedRole,
              grantedDurationHours,
              explicitAdministrator,
            ) => {
              await command(
                "resolveSupportRequest",
                {
                  requestId: dialog.request.id,
                  approve,
                  grantedRole,
                  grantedDurationHours,
                  explicitAdministrator,
                },
                approve
                  ? "Temporary access approved"
                  : "Support request denied",
              );
              setDialog(null);
            }}
          />
        ) : null}
        {dialog?.type === "vault-editor" && canUseVault && workspaceMutable ? (
          <VaultEditorDialog
            item={dialog.item}
            busy={busy}
            onClose={() => setDialog(null)}
            onSave={async (payload) => {
              await command(
                "saveVaultItem",
                payload,
                "Vault item encrypted and saved",
              );
              setDialog(null);
            }}
          />
        ) : null}
        {dialog?.type === "vault-reveal" && canUseVault ? (
          <VaultRevealDialog
            item={dialog.item}
            busy={busy}
            onClose={() => setDialog(null)}
          />
        ) : null}
        {dialog?.type === "account-security" ? (
          <AccountSecurityDialog onClose={() => setDialog(null)} />
        ) : null}
        {busy ? (
          <div className="busy-indicator" role="status">
            <LoaderCircle className="spin" /> Working securely…
          </div>
        ) : null}
      </div>
    </SidebarProvider>
  );
}

type ProvisioningWorkspaceDraft = {
  name: string;
  administratorEmails: string;
};

type ProvisioningInvitationDraft = {
  email: string;
  role: Exclude<WorkspaceRole, "administrator">;
  workspaceIndex: number;
};

function provisioningRecord(
  run: PlatformProvisioningRun | undefined,
  step: number,
) {
  return run?.steps?.[String(step)] ?? {};
}

function provisioningText(
  record: Record<string, unknown>,
  key: string,
  fallback = "",
) {
  return typeof record[key] === "string" ? record[key] : fallback;
}

function provisioningNumber(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
) {
  return typeof record[key] === "number" && Number.isFinite(record[key])
    ? record[key]
    : fallback;
}

function provisioningEmails(value: string) {
  return [
    ...new Set(
      value
        .split(/\r?\n|,/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function provisioningDate(value: unknown, fallback: Date) {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString().slice(0, 10);
  }
  return fallback.toISOString().slice(0, 10);
}

export function PlatformProvisioningDialog({
  busy,
  initialRun,
  onClose,
  onSave,
  onComplete,
}: {
  busy: boolean;
  initialRun?: PlatformProvisioningRun;
  onClose: () => void;
  onSave: (
    runId: string | null,
    step: number,
    data: Record<string, unknown>,
  ) => Promise<{
    runId: string;
    currentStep: number;
    completedSteps: number[];
  }>;
  onComplete: (runId: string) => Promise<PlatformProvisioningResult>;
}) {
  const identity = provisioningRecord(initialRun, 1);
  const branding = provisioningRecord(initialRun, 2);
  const workspaceStep = provisioningRecord(initialRun, 3);
  const commercial = provisioningRecord(initialRun, 4);
  const owners = provisioningRecord(initialRun, 5);
  const invitationStep = provisioningRecord(initialRun, 6);
  const rawWorkspaces = Array.isArray(workspaceStep.workspaces)
    ? workspaceStep.workspaces
    : [];
  const rawInvitations = Array.isArray(invitationStep.teamInvitations)
    ? invitationStep.teamInvitations
    : [];
  const entitlements =
    commercial.entitlements && typeof commercial.entitlements === "object"
      ? (commercial.entitlements as Record<string, unknown>)
      : {};
  const today = new Date();
  const defaultEnd = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1_000);

  const [runId, setRunId] = useState<string | null>(initialRun?.id ?? null);
  const [step, setStep] = useState(
    Math.max(1, Math.min(6, initialRun?.currentStep ?? 1)),
  );
  const [completedSteps, setCompletedSteps] = useState(
    initialRun?.completedSteps ?? [],
  );
  const [legalName, setLegalName] = useState(
    provisioningText(identity, "legalName"),
  );
  const [displayName, setDisplayName] = useState(
    provisioningText(identity, "displayName"),
  );
  const [primaryContactName, setPrimaryContactName] = useState(
    provisioningText(identity, "primaryContactName"),
  );
  const [primaryContactEmail, setPrimaryContactEmail] = useState(
    provisioningText(identity, "primaryContactEmail"),
  );
  const [country, setCountry] = useState(
    provisioningText(identity, "country", "QA"),
  );
  const [accentColor, setAccentColor] = useState(
    provisioningText(branding, "accentColor", "#2f6fed"),
  );
  const [logoMediaId, setLogoMediaId] = useState(
    provisioningText(branding, "logoMediaId"),
  );
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [workspaces, setWorkspaces] = useState<ProvisioningWorkspaceDraft[]>(
    rawWorkspaces.length
      ? rawWorkspaces.map((candidate) => {
          const value =
            candidate && typeof candidate === "object"
              ? (candidate as Record<string, unknown>)
              : {};
          return {
            name: provisioningText(value, "name"),
            administratorEmails: Array.isArray(value.administratorEmails)
              ? value.administratorEmails
                  .filter((email): email is string => typeof email === "string")
                  .join("\n")
              : "",
          };
        })
      : [{ name: "", administratorEmails: "" }],
  );
  const [pilotStart, setPilotStart] = useState(
    provisioningDate(commercial.pilotStart, today),
  );
  const [pilotEnd, setPilotEnd] = useState(
    provisioningDate(commercial.pilotEnd, defaultEnd),
  );
  const [maximumUsers, setMaximumUsers] = useState(
    provisioningNumber(entitlements, "maximumUsers", 100),
  );
  const [maximumCreators, setMaximumCreators] = useState(
    provisioningNumber(entitlements, "maximumCreators", 25),
  );
  const [storageGigabytes, setStorageGigabytes] = useState(
    Math.max(
      1,
      Math.round(
        provisioningNumber(entitlements, "storageBytes", 5_000_000_000) /
          1_000_000_000,
      ),
    ),
  );
  const [ownerEmails, setOwnerEmails] = useState(
    Array.isArray(owners.initialOwnerEmails)
      ? owners.initialOwnerEmails
          .filter((email): email is string => typeof email === "string")
          .join("\n")
      : "",
  );
  const [invitations, setInvitations] = useState<ProvisioningInvitationDraft[]>(
    rawInvitations.map((candidate) => {
      const value =
        candidate && typeof candidate === "object"
          ? (candidate as Record<string, unknown>)
          : {};
      const selectedRole = provisioningText(value, "role", "viewer");
      return {
        email: provisioningText(value, "email"),
        role: (
          ["creator", "reviewer", "publisher", "viewer"] as const
        ).includes(
          selectedRole as "creator" | "reviewer" | "publisher" | "viewer",
        )
          ? (selectedRole as Exclude<WorkspaceRole, "administrator">)
          : "viewer",
        workspaceIndex: provisioningNumber(value, "workspaceIndex", 0),
      };
    }),
  );
  const [created, setCreated] = useState<PlatformProvisioningResult | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const stepLabels = [
    "Identity",
    "Branding",
    "Workspaces",
    "Pilot",
    "Owners",
    "Invites",
  ];

  function stepData(currentStep: number): Record<string, unknown> {
    if (currentStep === 1) {
      if (
        [legalName, displayName, primaryContactName].some(
          (value) => value.trim().length < 2,
        ) ||
        !primaryContactEmail.includes("@") ||
        country.trim().length !== 2
      ) {
        throw new Error(
          "Complete the organization identity and primary contact.",
        );
      }
      return {
        legalName: legalName.trim(),
        displayName: displayName.trim(),
        primaryContactName: primaryContactName.trim(),
        primaryContactEmail: primaryContactEmail.trim().toLowerCase(),
        country: country.trim().toUpperCase(),
      };
    }
    if (currentStep === 2) {
      if (!/^#[0-9a-f]{6}$/i.test(accentColor)) {
        throw new Error("Use a six-digit hexadecimal accent color.");
      }
      if (!logoMediaId) throw new Error("Upload the organization logo first.");
      return { accentColor: accentColor.toLowerCase(), logoMediaId };
    }
    if (currentStep === 3) {
      if (
        !workspaces.length ||
        workspaces.some(
          (workspace) =>
            workspace.name.trim().length < 2 ||
            provisioningEmails(workspace.administratorEmails).length === 0,
        )
      ) {
        throw new Error(
          "Name every workspace and select at least one administrator for each.",
        );
      }
      return {
        workspaces: workspaces.map((workspace) => ({
          name: workspace.name.trim(),
          administratorEmails: provisioningEmails(
            workspace.administratorEmails,
          ),
        })),
      };
    }
    if (currentStep === 4) {
      if (
        !pilotStart ||
        !pilotEnd ||
        Date.parse(pilotEnd) <= Date.parse(pilotStart) ||
        maximumCreators > maximumUsers
      ) {
        throw new Error(
          "Use valid pilot dates and keep the creator limit within the user limit.",
        );
      }
      return {
        pilotStart,
        pilotEnd,
        maximumUsers,
        maximumCreators,
        storageBytes: Math.round(storageGigabytes * 1_000_000_000),
      };
    }
    if (currentStep === 5) {
      const initialOwnerEmails = provisioningEmails(ownerEmails);
      if (initialOwnerEmails.length < 2) {
        throw new Error("Provide at least two distinct organization owners.");
      }
      return { initialOwnerEmails };
    }
    if (
      invitations.some(
        (invitation) =>
          !invitation.email.includes("@") ||
          invitation.workspaceIndex < 0 ||
          invitation.workspaceIndex >= workspaces.length,
      )
    ) {
      throw new Error("Complete each team invitation or remove the empty row.");
    }
    return {
      teamInvitations: invitations.map((invitation) => ({
        email: invitation.email.trim().toLowerCase(),
        role: invitation.role,
        workspaceIndex: invitation.workspaceIndex,
      })),
    };
  }

  async function saveCurrent(complete = false, closeAfterSave = false) {
    setSaving(true);
    setError("");
    try {
      if (step === 2 && logoFile) {
        if (!runId)
          throw new Error(
            "Save organization identity before uploading a logo.",
          );
        if (
          !(["image/png", "image/jpeg"] as string[]).includes(logoFile.type)
        ) {
          throw new Error("Choose a PNG or JPEG logo.");
        }
        if (logoFile.size > 1024 * 1024) {
          throw new Error("The organization logo must be no larger than 1 MB.");
        }
        const uploadedId = await uploadProvisioningLogo(runId, logoFile);
        setLogoMediaId(uploadedId);
        setLogoFile(null);
        const saved = await onSave(runId, step, {
          accentColor: accentColor.toLowerCase(),
          logoMediaId: uploadedId,
        });
        setCompletedSteps(saved.completedSteps);
        if (closeAfterSave) onClose();
        else if (!complete) setStep(3);
        return;
      }
      const saved = await onSave(runId, step, stepData(step));
      setRunId(saved.runId);
      setCompletedSteps(saved.completedSteps);
      if (step === 1 && workspaces[0]?.name.trim() === "") {
        setWorkspaces((items) => [
          { ...items[0], name: displayName.trim() },
          ...items.slice(1),
        ]);
      }
      if (complete) {
        setCreated(await onComplete(saved.runId));
      } else if (closeAfterSave) {
        onClose();
      } else {
        setStep(Math.min(6, step + 1));
      }
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setSaving(false);
    }
  }

  if (created) {
    const appointmentLinks = created.workspaces.flatMap((workspace) =>
      workspace.appointments.map((appointment) => ({
        label: `${appointment.email} · administrator appointment`,
        url: `${window.location.origin}/app?appointment=${encodeURIComponent(appointment.token)}`,
      })),
    );
    const invitationLinks = created.invitations.map((invitation) => ({
      label: `${invitation.email} · ${titleCase(invitation.role)} invitation`,
      url: `${window.location.origin}/app?invite=${encodeURIComponent(invitation.token)}`,
    }));
    return (
      <Modal
        title="Organization provisioned"
        eyebrow="One-use delivery credentials"
        onClose={onClose}
        wide
      >
        <div className="modal-form created-invite">
          <CheckCircle2 />
          <div>
            <strong>
              The isolated organization and pilot workspaces are ready.
            </strong>
            <p>
              Notifications are queued for configured providers. These fallback
              links are shown only in this completion view; each is email-bound,
              expires, and can be redeemed once.
            </p>
          </div>
          <div className="created-links">
            {[...appointmentLinks, ...invitationLinks].map((link) => (
              <div className="copy-field" key={`${link.label}:${link.url}`}>
                <span>{link.label}</span>
                <input aria-label={link.label} readOnly value={link.url} />
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => navigator.clipboard.writeText(link.url)}
                >
                  <Copy /> Copy link
                </button>
              </div>
            ))}
          </div>
          <footer className="modal-footer">
            <span />
            <button className="button primary" type="button" onClick={onClose}>
              Done
            </button>
          </footer>
        </div>
      </Modal>
    );
  }

  const working = busy || saving;
  return (
    <Modal
      title="Provision a pilot organization"
      eyebrow={
        runId
          ? `Resumable draft · step ${step} of 6`
          : "Controlled provisioning"
      }
      onClose={onClose}
      wide
    >
      <form
        className="modal-form provisioning-form"
        onSubmit={(event) => {
          event.preventDefault();
          void saveCurrent(step === 6);
        }}
      >
        <ol
          className="provisioning-progress"
          aria-label="Provisioning progress"
        >
          {stepLabels.map((label, index) => {
            const number = index + 1;
            return (
              <li key={label} data-current={number === step || undefined}>
                <button
                  type="button"
                  disabled={
                    working ||
                    (!completedSteps.includes(number) && number !== step)
                  }
                  onClick={() => setStep(number)}
                  aria-current={number === step ? "step" : undefined}
                >
                  <span>
                    {completedSteps.includes(number) ? <Check /> : number}
                  </span>
                  {label}
                </button>
              </li>
            );
          })}
        </ol>

        {step === 1 ? (
          <div className="provisioning-step">
            <p className="modal-copy">
              Establish the customer record. This does not grant access or
              enable public sign-up.
            </p>
            <div className="form-grid two">
              <label className="field">
                <span>Legal name</span>
                <input
                  required
                  minLength={2}
                  maxLength={200}
                  value={legalName}
                  onChange={(event) => setLegalName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Display name</span>
                <input
                  required
                  minLength={2}
                  maxLength={128}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Primary contact</span>
                <input
                  required
                  minLength={2}
                  maxLength={128}
                  value={primaryContactName}
                  onChange={(event) =>
                    setPrimaryContactName(event.target.value)
                  }
                />
              </label>
              <label className="field">
                <span>Primary contact email</span>
                <input
                  required
                  type="email"
                  value={primaryContactEmail}
                  onChange={(event) =>
                    setPrimaryContactEmail(event.target.value)
                  }
                />
              </label>
              <label className="field">
                <span>Country code</span>
                <input
                  required
                  minLength={2}
                  maxLength={2}
                  value={country}
                  onChange={(event) =>
                    setCountry(event.target.value.toUpperCase())
                  }
                />
              </label>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="provisioning-step">
            <p className="modal-copy">
              Upload a private raster logo and choose the document accent
              inherited by new workspaces.
            </p>
            <div className="form-grid two">
              <label className="field color-field">
                <span>Organization accent</span>
                <span>
                  <input
                    type="color"
                    value={accentColor}
                    onChange={(event) => setAccentColor(event.target.value)}
                  />
                  <input
                    required
                    pattern="#[0-9A-Fa-f]{6}"
                    value={accentColor}
                    onChange={(event) => setAccentColor(event.target.value)}
                  />
                </span>
              </label>
              <label className="field">
                <span>Organization logo</span>
                <input
                  required={!logoMediaId}
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={(event) =>
                    setLogoFile(event.target.files?.[0] ?? null)
                  }
                />
                <small>
                  {logoFile
                    ? `${logoFile.name} · ${formatBytes(logoFile.size)}`
                    : logoMediaId
                      ? "Private logo already staged for this draft."
                      : "PNG or JPEG, up to 1 MB."}
                </small>
              </label>
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="provisioning-step">
            <div className="section-heading compact">
              <div>
                <h2>Workspaces and administrators</h2>
                <p>
                  Every workspace needs one or more explicitly selected
                  administrators.
                </p>
              </div>
              <button
                className="button secondary small"
                type="button"
                disabled={working || workspaces.length >= 10}
                onClick={() =>
                  setWorkspaces((items) => [
                    ...items,
                    { name: "", administratorEmails: "" },
                  ])
                }
              >
                <Plus /> Add workspace
              </button>
            </div>
            {workspaces.map((workspace, index) => (
              <div className="provisioning-row" key={index}>
                <label className="field">
                  <span>Workspace {index + 1} name</span>
                  <input
                    required
                    minLength={2}
                    maxLength={128}
                    value={workspace.name}
                    onChange={(event) =>
                      setWorkspaces((items) =>
                        items.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, name: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                <label className="field">
                  <span>Administrator emails</span>
                  <textarea
                    required
                    rows={2}
                    value={workspace.administratorEmails}
                    onChange={(event) =>
                      setWorkspaces((items) =>
                        items.map((item, itemIndex) =>
                          itemIndex === index
                            ? {
                                ...item,
                                administratorEmails: event.target.value,
                              }
                            : item,
                        ),
                      )
                    }
                    placeholder={"owner@example.com\nadmin@example.com"}
                  />
                </label>
                {workspaces.length > 1 ? (
                  <button
                    className="icon-button danger"
                    type="button"
                    aria-label={`Remove workspace ${index + 1}`}
                    onClick={() =>
                      setWorkspaces((items) =>
                        items.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <Trash2 />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {step === 4 ? (
          <div className="provisioning-step">
            <p className="modal-copy">
              Set explicit pilot dates and conservative capacity limits.
              Payments and public trials remain disabled.
            </p>
            <div className="form-grid two">
              <label className="field">
                <span>Pilot start</span>
                <input
                  required
                  type="date"
                  value={pilotStart}
                  onChange={(event) => setPilotStart(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Pilot end</span>
                <input
                  required
                  type="date"
                  min={pilotStart}
                  value={pilotEnd}
                  onChange={(event) => setPilotEnd(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Maximum users</span>
                <input
                  required
                  type="number"
                  min={1}
                  max={100}
                  value={maximumUsers}
                  onChange={(event) =>
                    setMaximumUsers(Number(event.target.value))
                  }
                />
              </label>
              <label className="field">
                <span>Maximum creators</span>
                <input
                  required
                  type="number"
                  min={1}
                  max={maximumUsers}
                  value={maximumCreators}
                  onChange={(event) =>
                    setMaximumCreators(Number(event.target.value))
                  }
                />
              </label>
              <label className="field">
                <span>Private storage (GB)</span>
                <input
                  required
                  type="number"
                  min={1}
                  max={1000}
                  value={storageGigabytes}
                  onChange={(event) =>
                    setStorageGigabytes(Number(event.target.value))
                  }
                />
              </label>
            </div>
          </div>
        ) : null}

        {step === 5 ? (
          <div className="provisioning-step">
            <p className="modal-copy">
              Assign at least two organization owners so governance never
              depends on one account.
            </p>
            <label className="field">
              <span>Initial organization owner emails</span>
              <textarea
                required
                rows={5}
                value={ownerEmails}
                onChange={(event) => setOwnerEmails(event.target.value)}
                placeholder={"owner@example.com\nbackup-owner@example.com"}
              />
              <small>
                One per line. Owner appointments are email-bound, expire in 14
                days, and require verified accounts with MFA.
              </small>
            </label>
          </div>
        ) : null}

        {step === 6 ? (
          <div className="provisioning-step">
            <div className="section-heading compact">
              <div>
                <h2>Initial team invitations</h2>
                <p>
                  Optional, scoped, single-use invitations. Administrator access
                  is appointed separately.
                </p>
              </div>
              <button
                className="button secondary small"
                type="button"
                disabled={working || invitations.length >= 100}
                onClick={() =>
                  setInvitations((items) => [
                    ...items,
                    { email: "", role: "viewer", workspaceIndex: 0 },
                  ])
                }
              >
                <Plus /> Add invitation
              </button>
            </div>
            {invitations.length ? (
              invitations.map((invitation, index) => (
                <div className="provisioning-invite-row" key={index}>
                  <label className="field">
                    <span>Email</span>
                    <input
                      required
                      type="email"
                      value={invitation.email}
                      onChange={(event) =>
                        setInvitations((items) =>
                          items.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, email: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <div className="field">
                    <span>Role</span>
                    <SelectMenu
                      value={invitation.role}
                      onChange={(role) =>
                        setInvitations((items) =>
                          items.map((item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  role,
                                }
                              : item,
                          ),
                        )
                      }
                      ariaLabel={`Role for invitation ${index + 1}`}
                      options={[
                        { value: "viewer", label: "Viewer" },
                        { value: "creator", label: "Creator" },
                        { value: "reviewer", label: "Reviewer" },
                        { value: "publisher", label: "Publisher" },
                      ]}
                    />
                  </div>
                  <div className="field">
                    <span>Workspace</span>
                    <SelectMenu
                      value={String(invitation.workspaceIndex)}
                      onChange={(workspaceIndex) =>
                        setInvitations((items) =>
                          items.map((item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  workspaceIndex: Number(workspaceIndex),
                                }
                              : item,
                          ),
                        )
                      }
                      ariaLabel={`Workspace for invitation ${index + 1}`}
                      options={workspaces.map((workspace, workspaceIndex) => ({
                        value: String(workspaceIndex),
                        label:
                          workspace.name || `Workspace ${workspaceIndex + 1}`,
                      }))}
                    />
                  </div>
                  <button
                    className="icon-button danger"
                    type="button"
                    aria-label={`Remove invitation ${index + 1}`}
                    onClick={() =>
                      setInvitations((items) =>
                        items.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <Trash2 />
                  </button>
                </div>
              ))
            ) : (
              <div className="empty-inline">
                <Mail />
                <span>
                  <strong>No initial team invitations</strong>
                  <small>
                    You can invite members later from each workspace.
                  </small>
                </span>
              </div>
            )}
            <p className="privacy-caption">
              <ShieldCheck /> Completing provisioning creates the isolated
              records atomically and queues privacy-safe notifications.
            </p>
          </div>
        ) : null}

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="modal-footer">
          <button
            className="button ghost"
            type="button"
            disabled={working || step === 1}
            onClick={() => setStep((current) => Math.max(1, current - 1))}
          >
            <ArrowLeft /> Back
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={working}
            onClick={() => void saveCurrent(false, true)}
          >
            Save & close
          </button>
          <button className="button primary" type="submit" disabled={working}>
            {working ? (
              <LoaderCircle className="spin" />
            ) : step === 6 ? (
              <ShieldCheck />
            ) : (
              <ArrowRight />
            )}
            {step === 6 ? "Provision organization" : "Save & continue"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function SupportRequestDialog({
  workspace,
  busy,
  onClose,
  onRequest,
}: {
  workspace: PlatformWorkspace;
  busy: boolean;
  onClose: () => void;
  onRequest: (
    role: WorkspaceRole,
    reason: string,
    hours: number,
  ) => Promise<void>;
}) {
  const [role, setRole] = useState<WorkspaceRole>("viewer");
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState("4");
  const parsedHours = Number(hours);
  const validHours =
    hours.trim() !== "" &&
    Number.isInteger(parsedHours) &&
    parsedHours >= 1 &&
    parsedHours <= 168;
  return (
    <Modal
      title={`Request support access · ${workspace.name}`}
      eyebrow="Customer approval required"
      onClose={onClose}
    >
      <form
        className="modal-form"
        onSubmit={async (event: FormEvent) => {
          event.preventDefault();
          if (!validHours) return;
          await onRequest(role, reason.trim(), parsedHours);
        }}
      >
        <p className="modal-copy">
          The workspace&apos;s administrator is notified in-app, reviews your
          reason, and may adjust the granted role and duration. Access stays
          denied until they approve, expires automatically, and every action
          during access is recorded in the customer&apos;s audit history.
        </p>
        <div className="field">
          <span>Requested role</span>
          <SelectMenu
            className="form-select"
            value={role}
            onChange={setRole}
            ariaLabel="Requested role"
            options={WORKSPACE_ROLES.map((item) => ({
              value: item,
              label: titleCase(item),
            }))}
          />
          <small>
            Administrator-level access only ever operates within the
            customer&apos;s approval and remains locked out of membership,
            invitations, domains, groups, and support governance.
          </small>
        </div>
        <label className="field">
          <span>Why is access needed?</span>
          <textarea
            required
            minLength={10}
            maxLength={2000}
            rows={4}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Investigating a capture failure on the onboarding guide…"
          />
        </label>
        <div className="field">
          <span>Requested duration (1–168 hours)</span>
          <input
            type="number"
            min={1}
            max={168}
            required
            value={hours}
            onChange={(event) => setHours(event.target.value)}
          />
        </div>
        <footer className="modal-footer">
          <span />
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || reason.trim().length < 10 || !validHours}
          >
            <ShieldCheck /> Request access
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function AssignAdminDialog({
  workspace,
  busy,
  onClose,
  onAssign,
}: {
  workspace: PlatformWorkspace;
  busy: boolean;
  onClose: () => void;
  onAssign: (email: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  return (
    <Modal
      title={`Assign administrator · ${workspace.name}`}
      eyebrow="Platform administration"
      onClose={onClose}
    >
      <form
        className="modal-form"
        onSubmit={async (event: FormEvent) => {
          event.preventDefault();
          await onAssign(email.trim().toLowerCase());
        }}
      >
        <p className="modal-copy">
          The account must already have a verified email. This action creates or
          updates workspace membership and is audited without exposing document
          contents.
        </p>
        <label className="field">
          <span>Verified account email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="admin@example.com"
          />
        </label>
        <footer className="modal-footer">
          <span />
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || !email.includes("@")}
          >
            <UserCog /> Assign administrator
          </button>
        </footer>
      </form>
    </Modal>
  );
}

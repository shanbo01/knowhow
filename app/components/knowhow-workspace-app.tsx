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
import {
  disableMfa,
  regenerateMfaRecoveryCodes,
  revokeOtherSessions,
  updateAccountName,
  updateAccountPassword,
} from "../../lib/auth-client";
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
  extensionStoreUrls,
  syncKnowHowExtension,
  type ExtensionCompanion,
} from "../../lib/extension-bridge";
import type {
  AdminAppointment,
  BetaAccessGrant,
  BootstrapResponse,
  Guide,
  GuideSearchResult,
  Invitation,
  OrganizationAdministration,
  OrganizationRole,
  PlatformPricingCatalog,
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
  type PlatformSection,
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
import { HexColorPicker } from "./hex-color-picker";
import { SelectMenu } from "./select-menu";
import { ProductBrand } from "./product-brand";
import { WorkspaceLogo } from "./workspace-logo";
import { ExtensionInstallInstructions } from "./extension-install-instructions";
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
  | { type: "setup-wizard" }
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

const PLATFORM_NAV: Array<{
  section: PlatformSection;
  label: string;
  icon: typeof LayoutDashboard;
}> = [
  { section: "overview", label: "Overview", icon: LayoutDashboard },
  { section: "leads", label: "Leads", icon: Mail },
  { section: "accounts", label: "Accounts", icon: Building2 },
  { section: "support", label: "Support", icon: LifeBuoy },
  { section: "billing", label: "Billing", icon: CalendarDays },
  { section: "ops", label: "Activity", icon: History },
];

const NAV_LABELS: Record<View, string> = {
  Overview: "Home",
  Guides: "Library",
  Capture: "Capture",
  Groups: "Groups",
  Members: "People & access",
  Support: "Support",
  Organization: "Organization",
  Vault: "Vault",
  Settings: "Workspace settings",
  Platform: "Platform console",
};

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

function workspaceAccessLabel(roles: WorkspaceRole[]) {
  if (roles.includes("administrator")) return "Workspace administrator";

  const operationalRoles = (
    ["creator", "reviewer", "publisher"] as WorkspaceRole[]
  ).filter((role) => roles.includes(role));
  if (operationalRoles.length) {
    return operationalRoles.map(titleCase).join(" · ");
  }

  return "Workspace member";
}

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

function formatMinorAmount(value: number | null, currency: string) {
  if (value === null) return "Price not published";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(value / 100);
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

function countPhrase(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

const INVITE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BULK_INVITES = 50;

function parseInviteEmails(value: string) {
  const tokens = value
    .split(/[\s,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (
      token.length < 5 ||
      token.length > 320 ||
      !INVITE_EMAIL_PATTERN.test(token)
    ) {
      invalid.push(token);
      continue;
    }
    if (seen.has(token)) continue;
    seen.add(token);
    emails.push(token);
  }
  return { emails, invalid };
}

function workspaceOptionLabel(workspace: {
  id: string;
  name: string;
  slug: string;
}) {
  const name = workspace.name.trim();
  const slug = workspace.slug.trim();
  if (name && slug && name !== workspace.id) return `${name} · ${slug}`;
  if (name && name !== workspace.id) return name;
  return slug || workspace.id;
}

function formatEntitlement(kind: string, value: string | number | boolean) {
  const labels: Record<string, string> = {
    maximumUsers: "People",
    maximumCreators: "Creators",
    storageBytes: "Storage",
    extensionEnabled: "Capture",
    supportEnabled: "Support",
    removeBranding: "Custom branding",
    publicSignup: "Public signup",
    payments: "Payments",
    ssoScim: "SSO / SCIM",
  };
  const label = labels[kind] ?? titleCase(kind);
  if (typeof value === "boolean") return value ? label : null;
  if (kind === "storageBytes") return `${label} ${formatBytes(Number(value))}`;
  return `${label}: ${value}`;
}

function TrialChip({
  subscription,
}: {
  subscription?: {
    access: string;
    expiresAt: string | null;
    graceEndsAt: string | null;
  };
}) {
  if (!subscription) return null;
  if (subscription.access === "read_only") {
    return (
      <span className="trial-chip">
        Read-only until {formatDate(subscription.graceEndsAt ?? subscription.expiresAt ?? undefined)}
      </span>
    );
  }
  if (subscription.access !== "active" || !subscription.expiresAt) return null;
  return <span className="trial-chip">Ends {formatDate(subscription.expiresAt)}</span>;
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
        className={cn(
          "kh-dialog-content",
          wide && "kh-dialog-wide sm:max-w-3xl",
        )}
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
  NonNullable<
    BootstrapResponse["activeWorkspace"]
  >["onboarding"]["steps"][number]["id"],
  { title: string; description: string }
> = {
  workspace_readiness: {
    title: "Confirm workspace readiness",
    description: "Agree to keep ordinary business-process data in this workspace.",
  },
  teammate_invitation: {
    title: "Invite a teammate",
    description: "Send an invitation to the person who will try a guide with you.",
  },
  extension_installation: {
    title: "Install the capture extension",
    description: "Connect Chrome or Edge so you can record a real workflow.",
  },
  first_capture: {
    title: "Capture the first workflow",
    description: "Record one ordinary process and review the screenshots.",
  },
  first_edit: {
    title: "Edit the draft",
    description: "Make the captured steps clear, owned, and ready for review.",
  },
  first_publication: {
    title: "Publish the first guide",
    description: "Review it and publish it to the people who need it.",
  },
  teammate_completion: {
    title: "Have a teammate complete it",
    description: "Ask them to open the published guide and mark it complete.",
  },
};

function SetupWizard({
  onboarding,
  busy,
  canCapture,
  canManageAccess,
  chrome = "card",
  onConfirmReadiness,
  onNavigate,
  onOpenExtension,
  onDismiss,
}: {
  onboarding: NonNullable<BootstrapResponse["activeWorkspace"]>["onboarding"];
  busy: boolean;
  canCapture: boolean;
  canManageAccess: boolean;
  chrome?: "card" | "plain";
  onConfirmReadiness: () => Promise<void>;
  onNavigate: (view: View) => void;
  onOpenExtension: () => void;
  onDismiss: () => Promise<void>;
}) {
  const [ordinaryDataOnly, setOrdinaryDataOnly] = useState(false);
  const [policiesReviewed, setPoliciesReviewed] = useState(false);
  if (onboarding.completedAt) return null;
  const current = onboarding.steps.find((step) => !step.completed);
  const completed = onboarding.steps.filter((step) => step.completed).length;
  if (!current) return null;
  const copy = ONBOARDING_STEP_COPY[current.id];
  const continueBlocked =
    busy ||
    (current.id === "teammate_invitation" && !canManageAccess) ||
    (["extension_installation", "first_capture"].includes(current.id) &&
      !canCapture);

  const nextAction = () => {
    if (current.id === "teammate_invitation") {
      if (canManageAccess) onNavigate("Members");
      return;
    }
    if (current.id === "extension_installation") {
      if (canCapture) onOpenExtension();
      return;
    }
    if (current.id === "first_capture") {
      if (canCapture) onNavigate("Capture");
      return;
    }
    onNavigate("Guides");
  };

  const body = (
    <>
      {chrome === "card" ? (
        <div className="onboarding-wizard-header">
          <div className="onboarding-checklist-copy">
            <CardTitle>Getting started</CardTitle>
            <Badge variant="outline">
              {completed} of {onboarding.steps.length}
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label="Dismiss getting started"
            disabled={busy}
            onClick={() => void onDismiss()}
          >
            <X />
          </Button>
        </div>
      ) : (
        <div className="onboarding-wizard-header">
          <Badge variant="outline">
            {completed} of {onboarding.steps.length}
          </Badge>
        </div>
      )}
      <ol aria-label="Getting started steps">
        {onboarding.steps.map((step, index) => (
          <li
            key={step.id}
            className={
              step.completed
                ? "complete"
                : current.id === step.id
                  ? "current"
                  : ""
            }
            title={ONBOARDING_STEP_COPY[step.id].title}
          >
            <span>{step.completed ? <Check /> : index + 1}</span>
            <strong className="visually-hidden">
              {ONBOARDING_STEP_COPY[step.id].title}
            </strong>
          </li>
        ))}
      </ol>
      <div className="onboarding-wizard-step">
        <strong>Next: {copy.title}</strong>
        <p>{copy.description}</p>
        {current.id === "teammate_invitation" && !canManageAccess ? (
          <small>
            Ask a workspace administrator to invite the first teammate.
          </small>
        ) : current.id === "first_capture" && !canCapture ? (
          <small>
            Ask a creator or workspace administrator to complete the first
            capture.
          </small>
        ) : current.id === "extension_installation" && !canCapture ? (
          <small>
            Ask a creator or workspace administrator to install Capture.
          </small>
        ) : null}
      </div>
      {current.id === "workspace_readiness" ? (
        <div className="onboarding-readiness">
          <label className="choice-row">
            <input
              type="checkbox"
              checked={ordinaryDataOnly}
              onChange={(event) => setOrdinaryDataOnly(event.target.checked)}
            />
            <span>
              <strong>Ordinary business-process data only</strong>
              <small>
                No credentials, payments, health data, national IDs, or
                sensitive data.
              </small>
            </span>
          </label>
          <label className="choice-row">
            <input
              type="checkbox"
              checked={policiesReviewed}
              onChange={(event) => setPoliciesReviewed(event.target.checked)}
            />
            <span>
              <strong>Workspace policies reviewed</strong>
              <small>
                You have reviewed the terms and capture boundaries for this
                workspace.
              </small>
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
      ) : (
        <div className="onboarding-wizard-actions">
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={continueBlocked}
            onClick={nextAction}
          >
            {current.id === "extension_installation"
              ? "Install and pair"
              : "Continue"}{" "}
            <ArrowRight />
          </Button>
        </div>
      )}
      <div className="onboarding-wizard-footer">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={busy}
          onClick={() => void onDismiss()}
        >
          I’ll do this later
        </Button>
      </div>
    </>
  );

  if (chrome === "plain") {
    return <div className="onboarding-wizard-body">{body}</div>;
  }

  return (
    <Card className="onboarding-checklist onboarding-wizard" size="sm">
      <CardContent className="onboarding-checklist-content">{body}</CardContent>
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
  onOpenExtension,
  onDismiss,
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
  onOpenExtension: () => void;
  onDismiss: () => Promise<void>;
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
  const hasReviewWork = guides.some(
    (guide) => guide.canReview || guide.canPublish,
  );

  return (
    <div className="workspace-overview">
      <section className="overview-page-header">
        <div className="overview-heading">
          <h1>{guides.length === 0 ? "Welcome" : "Dashboard"}</h1>
          <p>
            {guides.length === 0
              ? "Start with a capture, a written guide, or an invitation."
              : canManageAccess
              ? "Monitor knowledge, reviews, engagement, and audience coverage."
              : canCreate
                ? "Continue your drafts, capture workflows, and follow reviews through publication."
                : hasReviewWork
                  ? "Review work waiting for you and move approved guidance toward publication."
                  : "Find the published guidance available to you and continue where you left off."}
          </p>
        </div>
      </section>

      {(canManageAccess || canCapture) &&
      !data.onboarding.completedAt &&
      !data.onboarding.dismissedAt ? (
        <SetupWizard
          onboarding={data.onboarding}
          busy={busy}
          canCapture={canCapture}
          canManageAccess={canManageAccess}
          onConfirmReadiness={onConfirmReadiness}
          onNavigate={onNavigate}
          onOpenExtension={onOpenExtension}
          onDismiss={onDismiss}
        />
      ) : null}

      {guides.length === 0 ? (
        data.onboarding.completedAt || !(canManageAccess || canCapture) ? (
        <section className="first-run-panel">
          <div>
            <p className="eyebrow">Get started</p>
            <h2>Make this workspace useful in the next few minutes.</h2>
            <p>
              Capture a real workflow, write the first guide, or invite someone
              to try it with you.
            </p>
          </div>
          <div className="first-run-actions">
            {canCapture ? (
              <button type="button" onClick={() => onNavigate("Capture")}>
                <Sparkles />
                <strong>Capture a workflow</strong>
                <span>Record the steps in Chrome or Edge.</span>
              </button>
            ) : null}
            {canCreate ? (
              <button type="button" onClick={onNewGuide}>
                <Plus />
                <strong>Write a guide</strong>
                <span>Start a private draft from scratch.</span>
              </button>
            ) : null}
            {canManageAccess ? (
              <button type="button" onClick={() => onNavigate("Members")}>
                <Users />
                <strong>Invite a teammate</strong>
                <span>Send a single-use invitation to their email.</span>
              </button>
            ) : null}
          </div>
        </section>
        ) : null
      ) : (
        <>
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
        </>
      )}
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
      </div>
      <section className="card table-card">
        {guides.length ? (
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
        ) : null}
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
            icon={guides.length ? Search : BookOpen}
            title={guides.length ? "No matching guides" : "No guides yet"}
            description={
              guides.length
                ? "Try another search or lifecycle filter."
                : "Create the first guide for this workspace."
            }
            action={
              !guides.length && canCreate ? (
                <Button onClick={onNew}>
                  <Plus /> Create guide
                </Button>
              ) : undefined
            }
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
  canCapture,
}: {
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
          {!canCapture ? (
            <p className="privacy-caption">
              Capture is not enabled for your role in this workspace.
            </p>
          ) : null}
        </div>
      </div>
      <section className="capture-hero card">
        <div className="capture-copy">
          <p className="eyebrow">Browser extension</p>
          <h2>Pair Chrome or Edge, then record the real work.</h2>
          <p>
            KnowHow captures click context and screenshots without passwords,
            clipboard contents, raw keystrokes, incognito sessions, or
            password-manager pages. Redaction happens before anything is
            uploaded.
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
                ? countPhrase(members.length, "workspace member")
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
            action={
              !busy ? (
                <button className="button primary" type="button" onClick={onInvite}>
                  <UserPlus /> Invite teammate
                </button>
              ) : undefined
            }
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
          fully audited; membership, invitations, and groups stay
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
                membership, invitations, groups, or support governance.
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
        <p className="privacy-caption">
          <Shield /> Changing roles does not add the member to any content
          audience.
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
            onClick={() =>
              onSave(
                roles,
                member.capabilities?.includes("vault") ? ["vault"] : [],
              )
            }
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
    emails: string[];
    label: string;
    role: WorkspaceRole;
    expiresInHours: number;
  }) => Promise<Array<{ email: string; token: string }>>;
}) {
  const [label, setLabel] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("viewer");
  const [expires, setExpires] = useState(72);
  const [created, setCreated] = useState<
    Array<{ email: string; token: string }>
  >([]);
  const parsed = parseInviteEmails(emailDraft);
  const overLimit = parsed.emails.length > MAX_BULK_INVITES;

  return (
    <Modal
      title="Invite a teammate"
      eyebrow="Signed workspace access"
      onClose={onClose}
      wide
    >
      <form
        className="modal-form invite-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            !parsed.emails.length ||
            parsed.invalid.length ||
            overLimit
          ) {
            return;
          }
          const result = await onCreate({
            emails: parsed.emails,
            label: label.trim(),
            role,
            expiresInHours: expires,
          });
          if (result.length) setCreated(result);
        }}
      >
        {created.length ? (
          <div className="created-invite">
            <CheckCircle2 />
            <div>
              <strong>
                {created.length === 1
                  ? "Invitation ready"
                  : `${created.length} invitations ready`}
              </strong>
              <p>Each token is shown once. Copy the links now.</p>
            </div>
            <div className="created-invite-list">
              {created.map((item) => {
                const url = `${origin}/app?invite=${encodeURIComponent(item.token)}`;
                return (
                  <div className="copy-field" key={item.email}>
                    <span className="created-invite-email">{item.email}</span>
                    <input readOnly value={url} aria-label={`${item.email} invitation link`} />
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => navigator.clipboard.writeText(url)}
                    >
                      <Copy /> Copy
                    </button>
                  </div>
                );
              })}
            </div>
            {created.length > 1 ? (
              <button
                className="button ghost small"
                type="button"
                onClick={() =>
                  navigator.clipboard.writeText(
                    created
                      .map(
                        (item) =>
                          `${item.email}\t${origin}/app?invite=${encodeURIComponent(item.token)}`,
                      )
                      .join("\n"),
                  )
                }
              >
                <Copy /> Copy all links
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <label className="field">
              <span>Invitee emails</span>
              <textarea
                required
                className="invite-emails"
                value={emailDraft}
                onChange={(event) => setEmailDraft(event.target.value)}
                placeholder={"teammate@example.com\nops@example.com"}
                aria-label="Invitee emails"
                rows={6}
              />
              <small>
                Paste one address per line, or separate them with commas. Each
                person must sign in or create an account with that exact email.
                {parsed.emails.length
                  ? ` ${countPhrase(parsed.emails.length, "address")} ready.`
                  : ""}
              </small>
              {parsed.invalid.length ? (
                <small className="form-error" role="alert">
                  Not valid: {parsed.invalid.slice(0, 6).join(", ")}
                  {parsed.invalid.length > 6
                    ? ` +${parsed.invalid.length - 6} more`
                    : ""}
                </small>
              ) : null}
              {overLimit ? (
                <small className="form-error" role="alert">
                  Invite at most {MAX_BULK_INVITES} people at a time.
                </small>
              ) : null}
            </label>
            <div className="invite-settings">
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
            </div>
            <p className="privacy-caption">
              <LockKeyhole /> No generic links. Every invitation is scoped to
              one verified email, single-use, expiring, and audited.
            </p>
          </>
        )}
        <footer className="modal-footer">
          <span />
          <button className="button secondary" type="button" onClick={onClose}>
            {created.length ? "Done" : "Cancel"}
          </button>
          {!created.length ? (
            <button
              className="button primary"
              type="submit"
              disabled={
                busy ||
                !parsed.emails.length ||
                parsed.invalid.length > 0 ||
                overLimit
              }
            >
              {busy ? <LoaderCircle className="spin" /> : <Link2 />}{" "}
              {parsed.emails.length > 1
                ? `Create ${parsed.emails.length} invitations`
                : "Create invitation"}
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
  const [creating, setCreating] = useState(false);
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
  onSave,
  onRefresh,
}: {
  workspaceId: string;
  workspaceName: string;
  initial: WorkspaceSettings;
  busy: boolean;
  onSave: (settings: WorkspaceSettings) => Promise<void>;
  onRefresh: () => Promise<BootstrapResponse>;
}) {
  const [settings, setSettings] = useState(initial);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState("");
  const update = <K extends keyof WorkspaceSettings>(
    key: K,
    value: WorkspaceSettings[K],
  ) => setSettings((current) => ({ ...current, [key]: value }));
  const disabled = busy || logoBusy;
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
            Control branding and restricted exports for this workspace.
          </p>
        </div>
        <button
          className="button primary"
          disabled={disabled}
          onClick={() => void onSave(settings)}
        >
          <Check /> Save settings
        </button>
      </div>
      <div className="settings-grid">
        <section className="card settings-card document-identity-card">
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
          <div className="color-picker-grid">
            <HexColorPicker
              value={settings.accentColor}
              onChange={(value) => update("accentColor", value)}
              label="Document accent"
              ariaLabel="Pick document accent"
              hint="Used in guide branding and annotations, not the application interface."
            />
            <HexColorPicker
              value={settings.clickTargetColor}
              onChange={(value) => update("clickTargetColor", value)}
              label="Click target"
              ariaLabel="Pick click target color"
              hint="Marks the next click in recorded guide steps."
            />
          </div>
          <label className={`choice-row emphasized${settings.removeBranding ? "" : " locked-choice"}`}>
            <input
              type="checkbox"
              checked={settings.removeBranding}
              disabled={!settings.removeBranding}
              onChange={(event) =>
                update("removeBranding", event.target.checked)
              }
            />
            <span>
              <strong>Remove KnowHow branding</strong>
              <small>
                {settings.removeBranding
                  ? "KnowHow branding is hidden on exports for this workspace."
                  : "Locked on this plan. Included on company and on-prem plans."}
              </small>
            </span>
          </label>
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

function PlatformPagedList<T>({
  items,
  initialPageSize = 10,
  alwaysShowControls = false,
  children,
}: {
  items: T[];
  initialPageSize?: number;
  alwaysShowControls?: boolean;
  children: (visible: T[]) => ReactNode;
}) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visible = items.slice(safePage * pageSize, safePage * pageSize + pageSize);
  return (
    <>
      {children(visible)}
      {alwaysShowControls || items.length > 5 ? (
        <ListPagination
          total={items.length}
          page={safePage}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(next) => {
            setPageSize(next);
            setPage(0);
          }}
        />
      ) : null}
    </>
  );
}

function PlatformAuditList({
  audits,
  workspaceName,
}: {
  audits: NonNullable<BootstrapResponse["platform"]>["platformAudits"];
  workspaceName: (workspaceId: string) => string;
}) {
  const [query, setQuery] = useState("");
  const [action, setAction] = useState("all");
  const actionOptions = [...new Set(audits.map((audit) => audit.action))].sort();
  const rows = audits.filter((audit) => {
    const term = query.trim().toLowerCase();
    const haystack = [
      audit.action,
      titleCase(audit.action),
      workspaceName(audit.workspaceId),
    ]
      .join(" ")
      .toLowerCase();
    const matchesQuery = !term || haystack.includes(term);
    const matchesAction = action === "all" || audit.action === action;
    return matchesQuery && matchesAction;
  });

  if (!audits.length) {
    return (
      <p className="empty-copy">No control-plane audit events recorded.</p>
    );
  }

  return (
    <>
      <div className="filter-bar">
        <label className="search-field">
          <Search />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search actions or workspaces"
          />
        </label>
        <SelectMenu
          className="filter-select"
          leading={<Filter />}
          value={action}
          onChange={setAction}
          ariaLabel="Filter audit events by action"
          options={[
            { value: "all", label: "All actions" },
            ...actionOptions.map((value) => ({
              value,
              label: titleCase(value),
            })),
          ]}
        />
        <span className="result-count">
          {rows.length} {rows.length === 1 ? "event" : "events"}
        </span>
      </div>
      {rows.length ? (
        <PlatformPagedList
          key={`${query}:${action}`}
          items={rows}
          initialPageSize={5}
          alwaysShowControls
        >
          {(visible) =>
            visible.map((audit) => (
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
          }
        </PlatformPagedList>
      ) : (
        <p className="empty-copy">No matching control-plane changes.</p>
      )}
    </>
  );
}

export function PlatformView({
  platform,
  busy,
  section = "overview",
  workspaceId,
  onNavigate,
  onProvision,
  onStatus,
  onAssign,
  onRequestSupport,
  onExtendSubscription,
  onConvertSubscription,
  onApproveDeletion,
  onRevokeAppointment,
  canManageBetaAccess = false,
  onCreateBetaAccess,
  onRevokeBetaAccess,
  canManagePlatformControls = false,
  onPlatformControl,
}: {
  platform: NonNullable<BootstrapResponse["platform"]>;
  busy: boolean;
  section?: PlatformSection;
  workspaceId?: string;
  onNavigate?: (href: string) => void;
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
  canManageBetaAccess?: boolean;
  onCreateBetaAccess?: (input: {
    label?: string;
    email?: string;
    expiresAt: string;
    maxUses: number;
  }) => Promise<{ grant: BetaAccessGrant; code: string }>;
  onRevokeBetaAccess?: (grantId: string) => Promise<unknown>;
  canManagePlatformControls?: boolean;
  onPlatformControl?: (
    action:
      | "createPricingCatalog"
      | "updatePricingCatalog"
      | "retirePricingCatalog"
      | "createLifecycleSimulationTenant"
      | "simulateLifecycleState",
    payload: Record<string, unknown>,
    successMessage: string,
  ) => Promise<unknown>;
}) {
  const { metrics, workspaces, settings, appointments } = platform;
  const [query, setQuery] = useState("");
  const [pipelineStatus, setPipelineStatus] = useState(
    section === "support" ? "open" : "all",
  );
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
  const [betaAccessOpen, setBetaAccessOpen] = useState(false);
  const [pricingCatalogOpen, setPricingCatalogOpen] = useState<
    PlatformPricingCatalog | "create" | null
  >(null);
  const [simulationDialog, setSimulationDialog] = useState<
    | { mode: "create" }
    | { mode: "advance"; workspace: PlatformWorkspace }
    | null
  >(null);
  const platformNow = Date.parse(platform.generatedAt);
  const pricingCatalogs = platform.pricingCatalogs ?? [];
  const attentionTotal =
    platform.systemHealth.failedNotifications +
    platform.systemHealth.overdueSupport +
    platform.systemHealth.expiringWithinSevenDays +
    platform.systemHealth.deletionApprovals +
    platform.systemHealth.failedOperations;
  const openSupportCount = platform.support.filter(
    (ticket) => ticket.status !== "closed",
  ).length;
  const activeBetaGrants = platform.betaAccess.grants.filter(
    (grant) => grant.status === "active",
  );
  const platformAdministratorCount = new Set(
    workspaces.flatMap((workspace) =>
      workspace.administrators.map((admin) => admin.userId),
    ),
  ).size;
  const actionableDeletionCases = platform.deletionCases.filter(
    (item) => item.status !== "completed",
  );
  const simulationWorkspaces = workspaces.filter(
    (workspace) => workspace.simulation?.synthetic,
  );
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
  const accountRows = filtered.filter(
    (workspace) =>
      pipelineStatus === "all" || workspace.status === pipelineStatus,
  );
  const leadRows = platform.leads.filter((lead) => {
    const term = query.trim().toLowerCase();
    const haystack = [
      lead.organization,
      lead.contactName,
      lead.email,
      lead.kind,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const matchesQuery = !term || haystack.includes(term);
    const matchesStatus =
      pipelineStatus === "all" || lead.status === pipelineStatus;
    return matchesQuery && matchesStatus;
  });
  const supportRows = platform.support.filter((ticket) => {
    const term = query.trim().toLowerCase();
    const haystack = [
      workspaceName(ticket.workspaceId),
      ticket.requesterName,
      ticket.status,
    ]
      .join(" ")
      .toLowerCase();
    const matchesQuery = !term || haystack.includes(term);
    const matchesStatus =
      pipelineStatus === "all" ||
      (pipelineStatus === "open"
        ? ticket.status !== "closed"
        : ticket.status === pipelineStatus);
    return matchesQuery && matchesStatus;
  });
  const subscriptionRows = platform.subscriptions
    .filter((subscription) => {
      const term = query.trim().toLowerCase();
      const matchesQuery =
        !term ||
        `${workspaceName(subscription.workspaceId)} ${subscription.kind} ${subscription.status} ${subscription.access}`
          .toLowerCase()
          .includes(term);
      const matchesStatus =
        pipelineStatus === "all" || subscription.status === pipelineStatus;
      return matchesQuery && matchesStatus;
    })
    .sort((left, right) => {
      if (!left.expiresAt && !right.expiresAt) return 0;
      if (!left.expiresAt) return 1;
      if (!right.expiresAt) return -1;
      return left.expiresAt.localeCompare(right.expiresAt);
    });

  const openSection = (next: PlatformSection, id?: string) => {
    onNavigate?.(platformHref(next, id));
  };
  const selectedWorkspace =
    section === "accounts" && workspaceId
      ? (workspaces.find((item) => item.id === workspaceId) ?? null)
      : null;
  const selectedSubscription = selectedWorkspace
    ? platform.subscriptions.find(
        (item) => item.workspaceId === selectedWorkspace.id,
      )
    : null;
  const selectedEntitlements = selectedWorkspace
    ? platform.entitlements.filter(
        (item) => item.workspaceId === selectedWorkspace.id,
      )
    : [];
  const selectedActivation = selectedWorkspace
    ? platform.activation.find(
        (item) => item.workspaceId === selectedWorkspace.id,
      )
    : null;
  const selectedSupport = selectedWorkspace
    ? platform.support.filter(
        (item) => item.workspaceId === selectedWorkspace.id,
      )
    : [];
  const selectedAudits = selectedWorkspace
    ? platform.platformAudits.filter(
        (item) => item.workspaceId === selectedWorkspace.id,
      )
    : [];
  const heading =
    section === "leads"
      ? {
          eyebrow: "Inbound",
          title: "Leads",
          copy: "Contact requests from the public site. Customer document contents stay private.",
        }
      : section === "accounts"
        ? {
            eyebrow: "Tenants",
            title: selectedWorkspace ? selectedWorkspace.name : "Accounts",
            copy: selectedWorkspace
              ? "Subscription, people, support, and usage for this workspace."
              : "Every workspace, with organization context where it exists.",
          }
        : section === "support"
          ? {
              eyebrow: "Support SLA",
              title: "Support",
              copy: "Open support work across tenants. One-business-day target.",
            }
          : section === "billing"
            ? {
                eyebrow: "Commercial lifecycle",
                title: "Billing",
                copy: "Subscriptions, entitlements, and private pricing catalogs.",
              }
            : section === "ops"
              ? {
                  eyebrow: "Control plane",
                  title: "Activity",
                  copy: "Audit, delivery failures, deletion approvals, and appointments.",
                }
              : {
                  eyebrow: "Product owner",
                  title: "Platform administration",
                  copy: "Manage tenant health and aggregate usage without opening customer document contents or secrets.",
                };

  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          {selectedWorkspace ? (
            <button
              className="text-button"
              type="button"
              onClick={() => openSection("accounts")}
            >
              <ArrowLeft /> Accounts
            </button>
          ) : null}
          <p className="eyebrow">{heading.eyebrow}</p>
          <h1>{heading.title}</h1>
          <p>{heading.copy}</p>
        </div>
        <div className="platform-page-scope" role="note">
          <ShieldCheck />
          <span>
            <strong>Privacy boundary</strong>
            <small>Metadata and aggregate usage only</small>
          </span>
        </div>
      </div>

      {section === "overview" ? (
        <>
          <section
            className={cn(
              "platform-command-card",
              attentionTotal ? "has-attention" : "is-healthy",
            )}
          >
            <div className="platform-command-copy">
              <span className="platform-command-icon">
                {attentionTotal ? <CircleAlert /> : <CheckCircle2 />}
              </span>
              <div>
                <p className="eyebrow">Command center</p>
                <h2>
                  {attentionTotal
                    ? `${countPhrase(attentionTotal, "item")} need attention`
                    : "Everything is operating normally"}
                </h2>
                <p>
                  {attentionTotal
                    ? "Review the live queues below, then open the affected account for context and action."
                    : `No delivery, support, retention, or usage failures across ${countPhrase(workspaces.length, "workspace")}.`}
                </p>
              </div>
            </div>
            <div className="platform-command-actions">
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => openSection("accounts")}
              >
                <Building2 /> Browse accounts
              </Button>
              <Button
                size="sm"
                type="button"
                disabled={busy}
                onClick={onProvision}
              >
                <Plus /> Provision organization
              </Button>
            </div>
            <div className="platform-command-meta">
              <span>
                <ShieldCheck /> Customer content remains private
              </span>
              <span>
                <RefreshCw /> Snapshot {formatDate(platform.generatedAt, true)}
              </span>
              {platform.provisioningRuns.length ? (
                <button type="button" disabled={busy} onClick={onProvision}>
                  <Building2 />
                  {countPhrase(
                    platform.provisioningRuns.length,
                    "resumable provisioning draft",
                  )}
                  <ArrowRight />
                </button>
              ) : null}
            </div>
          </section>

          <section className="metric-grid platform-metrics">
            <MetricCard
              label="Workspaces"
              value={workspaces.length}
              hint={`${metrics.suspendedWorkspaces} suspended · ${metrics.archivedWorkspaces} archived`}
              icon={Building2}
              tone="accent"
            />
            <MetricCard
              label="People"
              value={metrics.users}
              hint="Across every tenant"
              icon={Users}
            />
            <MetricCard
              label="Knowledge"
              value={metrics.published + metrics.drafts}
              hint={`${metrics.published} published · ${metrics.drafts} drafts`}
              icon={BookOpen}
            />
            <MetricCard
              label="Engagement"
              value={metrics.views + metrics.completions}
              hint={`${metrics.views} views · ${metrics.completions} completions`}
              icon={Eye}
            />
            <MetricCard
              label="Operations"
              value={metrics.captures + metrics.exports}
              hint={`${metrics.captures} captures · ${metrics.exports} exports`}
              icon={Activity}
            />
          </section>

          <div className="platform-overview-grid">
            <section className="card table-card platform-health-card">
              <div className="section-heading compact">
                <div>
                  <p className="eyebrow">Operational health</p>
                  <h2>Live queues</h2>
                </div>
                <span className="privacy-caption">
                  <ShieldCheck /> Counts and timestamps only
                </span>
              </div>
              <div className="platform-queue">
                <button
                  className={cn(
                    platform.systemHealth.failedNotifications && "needs-attention",
                  )}
                  type="button"
                  onClick={() => openSection("ops")}
                >
                  <Mail />
                  <span>
                    <strong>Failed notifications</strong>
                    <small>Delivery retry queue</small>
                  </span>
                  <b>{platform.systemHealth.failedNotifications}</b>
                </button>
                <button
                  className={cn(
                    platform.systemHealth.overdueSupport && "needs-attention",
                  )}
                  type="button"
                  onClick={() => openSection("support")}
                >
                  <LifeBuoy />
                  <span>
                    <strong>Overdue support</strong>
                    <small>One-business-day target</small>
                  </span>
                  <b>{platform.systemHealth.overdueSupport}</b>
                </button>
                <button
                  className={cn(
                    platform.systemHealth.expiringWithinSevenDays &&
                      "needs-attention",
                  )}
                  type="button"
                  onClick={() => openSection("billing")}
                >
                  <CalendarDays />
                  <span>
                    <strong>Expiring soon</strong>
                    <small>Within seven days</small>
                  </span>
                  <b>{platform.systemHealth.expiringWithinSevenDays}</b>
                </button>
                <button
                  className={cn(
                    platform.systemHealth.deletionApprovals && "needs-attention",
                  )}
                  type="button"
                  onClick={() => openSection("ops")}
                >
                  <Trash2 />
                  <span>
                    <strong>Deletion approvals</strong>
                    <small>Owner confirmation required</small>
                  </span>
                  <b>{platform.systemHealth.deletionApprovals}</b>
                </button>
                <button
                  className={cn(
                    platform.systemHealth.failedOperations && "needs-attention",
                  )}
                  type="button"
                  onClick={() => openSection("ops")}
                >
                  <CircleAlert />
                  <span>
                    <strong>Failed operations</strong>
                    <small>Content-free usage events</small>
                  </span>
                  <b>{platform.systemHealth.failedOperations}</b>
                </button>
              </div>
            </section>
            <section className="card table-card platform-audit-preview">
              <div className="section-heading compact">
                <div>
                  <p className="eyebrow">Platform audit</p>
                  <h2>Recent changes</h2>
                </div>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => openSection("ops")}
                >
                  View all <ArrowRight />
                </button>
              </div>
              {platform.platformAudits.length ? (
                platform.platformAudits.slice(0, 5).map((audit) => (
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
                <p className="empty-copy">
                  No control-plane audit events recorded.
                </p>
              )}
            </section>
          </div>

          <section className="platform-boundary-note">
            <span>
              <LockKeyhole />
            </span>
            <div>
              <strong>Isolated workspaces, explicit membership</strong>
              <small>
                Self-service limit: {settings.selfServiceWorkspaceLimit}{" "}
                trial workspace
                {settings.selfServiceWorkspaceLimit === 1 ? "" : "s"} per owner;
                every other membership is exact-email and invitation-only.
              </small>
            </div>
            <StatusBadge status="active" />
          </section>
        </>
      ) : null}

      {section === "leads" ? (
        <>
          <section className="card table-card">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Inbound requests</p>
                <h2>Contact leads</h2>
              </div>
              <Mail />
            </div>
            <div className="filter-bar">
              <label className="search-field">
                <Search />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search leads"
                />
              </label>
              <SelectMenu
                className="filter-select"
                leading={<Filter />}
                value={pipelineStatus}
                onChange={setPipelineStatus}
                ariaLabel="Filter leads by status"
                options={[
                  { value: "all", label: "All statuses" },
                  ...[...new Set(platform.leads.map((lead) => lead.status))].map(
                    (status) => ({
                      value: status,
                      label: titleCase(status.replaceAll("_", " ")),
                    }),
                  ),
                ]}
              />
              <span className="result-count" aria-live="polite">
                {leadRows.length} {leadRows.length === 1 ? "lead" : "leads"}
              </span>
            </div>
            {leadRows.length ? (
              <PlatformPagedList items={leadRows}>
                {(visible) =>
                  visible.map((lead) => (
                    <div className="platform-compact-row" key={lead.id}>
                      <span className="member-main">
                        <strong>
                          {lead.organization || lead.contactName || lead.email}
                        </strong>
                        <small>
                          {lead.contactName || "Unnamed contact"} · {lead.email}
                        </small>
                        <small>
                          {titleCase(lead.kind)} ·{" "}
                          {formatDate(lead.occurredAt, true)}
                        </small>
                      </span>
                      <StatusBadge status={lead.status} />
                    </div>
                  ))
                }
              </PlatformPagedList>
            ) : (
              <div className="platform-empty-state">
                <span>
                  <Mail />
                </span>
                <strong>No inbound requests</strong>
                <small>
                  New contact and demo requests will appear here with their
                  current pipeline status.
                </small>
              </div>
            )}
          </section>

          <section className="card table-card platform-beta-access-card">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Private beta</p>
                <h2>Access grants</h2>
              </div>
              {canManageBetaAccess && onCreateBetaAccess ? (
                <button
                  className="button primary small"
                  type="button"
                  disabled={busy}
                  onClick={() => setBetaAccessOpen(true)}
                >
                  <Plus /> Create access
                </button>
              ) : (
                <span className="privacy-caption">
                  <LockKeyhole /> Owner or operations only
                </span>
              )}
            </div>
            <div className="platform-beta-summary">
              <span>
                <strong>{activeBetaGrants.length}</strong>
                <small>active grants</small>
              </span>
              <span>
                <strong>{platform.betaAccess.events.length}</strong>
                <small>recorded events</small>
              </span>
              <p>
                Issue time-limited, usage-capped admission without exposing the
                underlying code after creation.
              </p>
            </div>
            {platform.betaAccess.grants.length ? (
              <PlatformPagedList items={platform.betaAccess.grants}>
                {(visible) =>
                  visible.map((grant) => (
                    <div className="platform-ops-row" key={grant.id}>
                      <span className="invite-icon">
                        <KeyRound />
                      </span>
                      <span className="member-main">
                        <strong>{grant.label || "Private beta access"}</strong>
                        <small>
                          {grant.exactEmail || "Any approved email"} · expires{" "}
                          {formatDate(grant.expiresAt, true)}
                        </small>
                        <small>
                          {grant.usedCount} used · {grant.reservedCount} reserved ·{" "}
                          {Math.max(
                            0,
                            grant.maxUses - grant.usedCount - grant.reservedCount,
                          )}{" "}
                          remaining
                        </small>
                      </span>
                      <StatusBadge status={grant.status} />
                      {grant.status === "active" && onRevokeBetaAccess ? (
                        <button
                          className="button ghost small"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(`Revoke ${grant.label}?`)) {
                              void onRevokeBetaAccess(grant.id).catch(
                                () => undefined,
                              );
                            }
                          }}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </div>
                  ))
                }
              </PlatformPagedList>
            ) : (
              <div className="platform-empty-state compact">
                <span>
                  <KeyRound />
                </span>
                <strong>No beta access grants yet</strong>
                <small>Create a scoped grant when a private-beta user is ready.</small>
              </div>
            )}
          </section>
        </>
      ) : null}

      {section === "accounts" && !selectedWorkspace ? (
        <>
          <section
            className="platform-summary-strip"
            aria-label="Account summary"
          >
            <article>
              <Building2 />
              <span>
                <strong>{workspaces.length}</strong>
                <small>workspaces</small>
              </span>
            </article>
            <article>
              <CheckCircle2 />
              <span>
                <strong>{metrics.activeWorkspaces}</strong>
                <small>active</small>
              </span>
            </article>
            <article>
              <Users />
              <span>
                <strong>{platformAdministratorCount}</strong>
                <small>administrators</small>
              </span>
            </article>
            <article>
              <Building2 />
              <span>
                <strong>{platform.organizations.length}</strong>
                <small>organizations</small>
              </span>
            </article>
          </section>
          <section className="card table-card">
            <div className="section-heading compact">
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
              <SelectMenu
                className="filter-select"
                leading={<Filter />}
                value={pipelineStatus}
                onChange={setPipelineStatus}
                ariaLabel="Filter workspaces by status"
                options={[
                  { value: "all", label: "All statuses" },
                  { value: "active", label: "Active" },
                  { value: "suspended", label: "Suspended" },
                  { value: "archived", label: "Archived" },
                ]}
              />
              <span className="result-count" aria-live="polite">
                {accountRows.length}{" "}
                {accountRows.length === 1 ? "workspace" : "workspaces"}
              </span>
            </div>
            <div className="platform-table platform-account-table">
              <div className="platform-row platform-account-row platform-head">
                <span>Workspace</span>
                <span>Administrators</span>
                <span>Activity</span>
                <span>Status</span>
                <span />
              </div>
              <PlatformPagedList items={accountRows}>
                {(visible) =>
                  visible.map((workspace) => (
                    <div
                      className="platform-row platform-account-row"
                      key={workspace.id}
                    >
                      <button
                        className="workspace-cell text-button"
                        type="button"
                        onClick={() => openSection("accounts", workspace.id)}
                      >
                        <span className="workspace-avatar">
                          {workspace.name.slice(0, 1)}
                        </span>
                        <span>
                          <strong>{workspace.name}</strong>
                          <small>
                            {workspace.slug} ·{" "}
                            {countPhrase(workspace.memberCount, "member")} · created{" "}
                            {formatDate(workspace.createdAt)}
                            {workspace.supportGrant
                              ? ` · support ${titleCase(workspace.supportGrant.role)} until ${formatDate(workspace.supportGrant.expiresAt, true)}`
                              : workspace.supportRequest?.status === "pending"
                                ? " · support request pending"
                                : ""}
                          </small>
                        </span>
                      </button>
                      <span className="platform-admins">
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
                          type="button"
                          onClick={() => onAssign(workspace)}
                        >
                          <UserCog /> Assign
                        </button>
                      </span>
                      <span className="platform-account-usage">
                        <span>
                          <strong>
                            {workspace.publishedCount + workspace.draftCount}
                          </strong>
                          <small>guides</small>
                        </span>
                        <span>
                          <strong>{workspace.views}</strong>
                          <small>views</small>
                        </span>
                        <span>
                          <strong>{formatBytes(workspace.storageBytes)}</strong>
                          <small>storage</small>
                        </span>
                      </span>
                      <span>
                        <StatusBadge status={workspace.status} />
                      </span>
                      <span>
                        <RowMenu>
                          {workspace.status === "active" &&
                          !workspace.supportGrant ? (
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
                  ))
                }
              </PlatformPagedList>
            </div>
          </section>
          {platform.organizations.length ? (
            <details className="card table-card platform-organizations-card">
              <summary className="section-heading compact">
                <div>
                  <p className="eyebrow">Organizations</p>
                  <h2>Company directory</h2>
                </div>
                <span className="platform-details-summary">
                  {countPhrase(platform.organizations.length, "organization")}
                  <ChevronDown />
                </span>
              </summary>
              <div className="platform-organization-grid">
                {platform.organizations.map((organization) => (
                  <article key={organization.id}>
                    <span className="invite-icon">
                      <Building2 />
                    </span>
                    <span className="member-main">
                      <strong>{organization.displayName}</strong>
                      <small>
                        {organization.legalName} · {organization.country}
                      </small>
                      <small>
                        {countPhrase(
                          organization.workspaceCount,
                          "workspace",
                        )}
                      </small>
                    </span>
                    <StatusBadge status={organization.status} />
                  </article>
                ))}
              </div>
            </details>
          ) : null}
        </>
      ) : null}

      {selectedWorkspace ? (
        <>
          <section
            className="platform-summary-strip"
            aria-label={`${selectedWorkspace.name} account summary`}
          >
            <article>
              <Users />
              <span>
                <strong>{selectedWorkspace.memberCount}</strong>
                <small>members</small>
              </span>
            </article>
            <article>
              <BookOpen />
              <span>
                <strong>
                  {selectedWorkspace.publishedCount +
                    selectedWorkspace.draftCount}
                </strong>
                <small>guides</small>
              </span>
            </article>
            <article>
              <Eye />
              <span>
                <strong>{selectedWorkspace.views}</strong>
                <small>views</small>
              </span>
            </article>
            <article>
              <FileDown />
              <span>
                <strong>{formatBytes(selectedWorkspace.storageBytes)}</strong>
                <small>storage</small>
              </span>
            </article>
          </section>
          <section className="card table-card platform-account-hero">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Account</p>
                <h2>{selectedWorkspace.slug}</h2>
              </div>
              <StatusBadge status={selectedWorkspace.status} />
            </div>
            <div className="platform-account-summary-row">
              <span className="member-main">
                <strong>
                  Workspace administration
                </strong>
                <small>
                  Created {formatDate(selectedWorkspace.createdAt)} ·{" "}
                  {countPhrase(
                    selectedWorkspace.administrators.length,
                    "administrator",
                  )}
                </small>
              </span>
              <div className="modal-actions compact-actions">
                <button
                  className="button secondary small"
                  type="button"
                  disabled={busy}
                  onClick={() => onAssign(selectedWorkspace)}
                >
                  <UserCog /> Assign
                </button>
                {selectedWorkspace.status === "active" &&
                !selectedWorkspace.supportGrant ? (
                  <button
                    className="button secondary small"
                    type="button"
                    disabled={busy}
                    onClick={() => onRequestSupport(selectedWorkspace)}
                  >
                    Support
                  </button>
                ) : null}
                {selectedWorkspace.status === "active" ? (
                  <button
                    className="button ghost small"
                    type="button"
                    disabled={busy}
                    onClick={() => onStatus(selectedWorkspace.id, "suspended")}
                  >
                    Suspend
                  </button>
                ) : (
                  <button
                    className="button ghost small"
                    type="button"
                    disabled={busy}
                    onClick={() => onStatus(selectedWorkspace.id, "active")}
                  >
                    Restore
                  </button>
                )}
              </div>
            </div>
            <div className="platform-account-admins">
              {selectedWorkspace.administrators.map((admin) => (
                <div className="platform-compact-row" key={admin.userId}>
                  <span className="workspace-avatar">
                    {initials(admin.name, admin.email)}
                  </span>
                  <span className="member-main">
                    <strong>{admin.name || admin.email}</strong>
                    <small>{admin.email}</small>
                  </span>
                  <small>Administrator</small>
                </div>
              ))}
            </div>
          </section>
          <div className="platform-account-detail-grid">
          <section className="card table-card">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Commercial lifecycle</p>
                <h2>Subscription</h2>
              </div>
            </div>
            {selectedSubscription ? (
              <div className="platform-ops-row">
                <span className="invite-icon">
                  <CalendarDays />
                </span>
                <span className="member-main">
                  <strong>{titleCase(selectedSubscription.kind)}</strong>
                  <small>
                    access {titleCase(selectedSubscription.access)}
                    {selectedSubscription.expiresAt
                      ? ` · expires ${formatDate(selectedSubscription.expiresAt, true)}`
                      : " · no fixed expiry"}
                  </small>
                  <small>
                    {selectedEntitlements.length
                      ? selectedEntitlements
                          .map((entitlement) =>
                            formatEntitlement(
                              entitlement.kind,
                              entitlement.value,
                            ),
                          )
                          .filter(Boolean)
                          .join(" · ")
                      : "No explicit entitlement overrides"}
                  </small>
                </span>
                <StatusBadge status={selectedSubscription.status} />
              </div>
            ) : (
              <p className="empty-copy">No subscription recorded.</p>
            )}
          </section>
          <section className="card table-card">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Activation</p>
                <h2>First-value progress</h2>
              </div>
            </div>
            {selectedActivation ? (
              <div className="platform-compact-row">
                <span className="member-main">
                  <small>
                    {selectedActivation.firstPublishedAt
                      ? `Published ${formatDate(selectedActivation.firstPublishedAt, true)}`
                      : "Awaiting first publication"}
                  </small>
                  <small>
                    {selectedActivation.firstTeammateViewAt
                      ? `Teammate view ${formatDate(selectedActivation.firstTeammateViewAt, true)}`
                      : "Awaiting teammate view"}
                    {selectedActivation.firstTeammateCompletionAt
                      ? ` · completion ${formatDate(selectedActivation.firstTeammateCompletionAt, true)}`
                      : " · awaiting completion"}
                  </small>
                </span>
                <strong>
                  {
                    [
                      selectedActivation.firstPublishedAt,
                      selectedActivation.firstTeammateViewAt,
                      selectedActivation.firstTeammateCompletionAt,
                    ].filter(Boolean).length
                  }
                  /3
                </strong>
              </div>
            ) : (
              <p className="empty-copy">No activation events recorded.</p>
            )}
          </section>
          <section className="card table-card platform-account-support-card">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Support SLA</p>
                <h2>Open support work</h2>
              </div>
            </div>
            {selectedSupport.length ? (
              selectedSupport.map((ticket) => (
                <div className="platform-compact-row" key={ticket.id}>
                  <span className="member-main">
                    <strong>{ticket.requesterName}</strong>
                    <small>
                      target {formatDate(ticket.responseTargetAt, true)}
                    </small>
                  </span>
                  <StatusBadge status={ticket.status} />
                </div>
              ))
            ) : (
              <p className="empty-copy">No support cases for this account.</p>
            )}
          </section>
          <section className="card table-card platform-account-audit-card">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Platform audit</p>
                <h2>Recent control-plane changes</h2>
              </div>
            </div>
            {selectedAudits.length ? (
              selectedAudits.slice(0, 8).map((audit) => (
                <div className="platform-compact-row" key={audit.id}>
                  <span className="member-main">
                    <strong>{titleCase(audit.action)}</strong>
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
          </div>
        </>
      ) : null}

      {section === "support" ? (
        <>
        <section className="platform-summary-strip" aria-label="Support summary">
          <article>
            <LifeBuoy />
            <span>
              <strong>{openSupportCount}</strong>
              <small>open cases</small>
            </span>
          </article>
          <article>
            <CircleAlert />
            <span>
              <strong>{platform.systemHealth.overdueSupport}</strong>
              <small>overdue</small>
            </span>
          </article>
          <article>
            <Mail />
            <span>
              <strong>
                {
                  platform.support.filter(
                    (ticket) => ticket.status === "waiting_support",
                  ).length
                }
              </strong>
              <small>waiting on support</small>
            </span>
          </article>
          <article>
            <CheckCircle2 />
            <span>
              <strong>
                {
                  platform.support.filter(
                    (ticket) => ticket.status === "closed",
                  ).length
                }
              </strong>
              <small>closed</small>
            </span>
          </article>
        </section>
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Support SLA</p>
              <h2>Open support work</h2>
            </div>
            <LifeBuoy />
          </div>
          <div className="filter-bar">
            <label className="search-field">
              <Search />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search support work"
              />
            </label>
            <SelectMenu
              className="filter-select"
              leading={<Filter />}
              value={pipelineStatus}
              onChange={setPipelineStatus}
              ariaLabel="Filter support by status"
              options={[
                { value: "open", label: "Open cases" },
                { value: "all", label: "All statuses" },
                ...[
                  ...new Set(platform.support.map((ticket) => ticket.status)),
                ].map((status) => ({
                  value: status,
                  label: titleCase(status.replaceAll("_", " ")),
                })),
              ]}
            />
            <span className="result-count" aria-live="polite">
              {supportRows.length}{" "}
              {supportRows.length === 1 ? "case" : "cases"}
            </span>
          </div>
          {supportRows.length ? (
            <PlatformPagedList items={supportRows}>
              {(visible) =>
                visible.map((ticket) => {
                  const overdue =
                    ticket.status === "waiting_support" &&
                    Date.parse(ticket.responseTargetAt) < platformNow;
                  return (
                    <button
                      className="platform-compact-row platform-support-row"
                      type="button"
                      key={ticket.id}
                      onClick={() => openSection("accounts", ticket.workspaceId)}
                    >
                      <span className="member-main">
                        <strong>{workspaceName(ticket.workspaceId)}</strong>
                        <small>
                          {ticket.requesterName} · target{" "}
                          {formatDate(ticket.responseTargetAt, true)}
                        </small>
                      </span>
                      <StatusBadge status={overdue ? "overdue" : ticket.status} />
                    </button>
                  );
                })
              }
            </PlatformPagedList>
          ) : (
            <div className="platform-empty-state compact">
              <span>
                <CheckCircle2 />
              </span>
              <strong>No support work in this view</strong>
              <small>Change the filter to review completed cases.</small>
            </div>
          )}
        </section>
        </>
      ) : null}

      {section === "billing" ? (
        <>
          <section
            className="platform-summary-strip"
            aria-label="Subscription summary"
          >
            <article>
              <CalendarDays />
              <span>
                <strong>{platform.subscriptions.length}</strong>
                <small>subscriptions</small>
              </span>
            </article>
            <article>
              <Sparkles />
              <span>
                <strong>
                  {
                    platform.subscriptions.filter(
                      (subscription) => subscription.kind === "trial",
                    ).length
                  }
                </strong>
                <small>trials</small>
              </span>
            </article>
            <article>
              <CheckCircle2 />
              <span>
                <strong>
                  {
                    platform.subscriptions.filter(
                      (subscription) => subscription.kind === "paid",
                    ).length
                  }
                </strong>
                <small>contracts</small>
              </span>
            </article>
            <article>
              <CircleAlert />
              <span>
                <strong>{platform.systemHealth.expiringWithinSevenDays}</strong>
                <small>expiring soon</small>
              </span>
            </article>
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
            <div className="filter-bar">
              <label className="search-field">
                <Search />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search accounts or subscription types"
                />
              </label>
              <SelectMenu
                className="filter-select"
                leading={<Filter />}
                value={pipelineStatus}
                onChange={setPipelineStatus}
                ariaLabel="Filter subscriptions by status"
                options={[
                  { value: "all", label: "All statuses" },
                  ...[
                    ...new Set(
                      platform.subscriptions.map(
                        (subscription) => subscription.status,
                      ),
                    ),
                  ].map((status) => ({
                    value: status,
                    label: titleCase(status.replaceAll("_", " ")),
                  })),
                ]}
              />
              <span className="result-count" aria-live="polite">
                {subscriptionRows.length}{" "}
                {subscriptionRows.length === 1
                  ? "subscription"
                  : "subscriptions"}
              </span>
            </div>
            {subscriptionRows.length ? (
              <PlatformPagedList items={subscriptionRows}>
                {(visible) =>
                  visible.map((subscription) => {
                    const entitlements = platform.entitlements.filter(
                      (entitlement) =>
                        entitlement.workspaceId === subscription.workspaceId,
                    );
                    return (
                      <div
                        className="platform-ops-row platform-subscription-row"
                        key={subscription.id}
                      >
                        <span className="invite-icon">
                          <CalendarDays />
                        </span>
                        <button
                          className="member-main text-button"
                          type="button"
                          onClick={() =>
                            openSection("accounts", subscription.workspaceId)
                          }
                        >
                          <strong>
                            {workspaceName(subscription.workspaceId)}
                          </strong>
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
                                  .map((entitlement) =>
                                    formatEntitlement(
                                      entitlement.kind,
                                      entitlement.value,
                                    ),
                                  )
                                  .filter(Boolean)
                                  .join(" · ")
                              : "No explicit entitlement overrides"}
                          </small>
                        </button>
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
                }
              </PlatformPagedList>
            ) : (
              <div className="platform-empty-state compact">
                <span>
                  <CalendarDays />
                </span>
                <strong>No matching subscriptions</strong>
                <small>
                  Try another filter, or provision an organization to create a
                  trial subscription.
                </small>
              </div>
            )}
          </section>
          <section className="card table-card">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Commercial configuration</p>
                <h2>Private pricing catalog</h2>
              </div>
              {canManagePlatformControls && onPlatformControl ? (
                <button
                  className="button primary"
                  type="button"
                  disabled={busy}
                  onClick={() => setPricingCatalogOpen("create")}
                >
                  <Plus /> New catalog
                </button>
              ) : (
                <span className="privacy-caption">
                  <ShieldCheck /> Owner or operations only
                </span>
              )}
            </div>
            <p className="empty-copy beta-access-copy">
              Version trial timing, capacity, internal prices, and included
              services without publishing numeric pricing. Security fundamentals
              remain included and payment collection stays off until you enable
              it.
            </p>
            {pricingCatalogs.length ? (
              pricingCatalogs.map((catalog) => (
                <div className="platform-ops-row" key={catalog.id}>
                  <span className="invite-icon">
                    <BarChart3 />
                  </span>
                  <span className="member-main">
                    <strong>{catalog.name}</strong>
                    <small>
                      {catalog.catalogVersion} · {catalog.trial.days}-day trial ·{" "}
                      {catalog.trial.graceDays}-day grace ·{" "}
                      {catalog.trial.retentionDays}-day retention
                    </small>
                    <small>
                      {formatMinorAmount(
                        catalog.baseWorkspace.amountMinor,
                        catalog.currency,
                      )}{" "}
                      per workspace · {catalog.baseWorkspace.includedActiveCreators}{" "}
                      creators · {catalog.baseWorkspace.includedActiveUsers} users ·{" "}
                      {formatBytes(catalog.baseWorkspace.includedStorageBytes)}
                    </small>
                  </span>
                  <StatusBadge status={catalog.status} />
                  {canManagePlatformControls && onPlatformControl ? (
                    <div className="modal-actions compact-actions">
                      {catalog.status !== "retired" ? (
                        <button
                          className="button secondary small"
                          type="button"
                          disabled={busy}
                          onClick={() => setPricingCatalogOpen(catalog)}
                        >
                          Edit
                        </button>
                      ) : null}
                      {catalog.status !== "retired" ? (
                        <button
                          className="button ghost small"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Retire ${catalog.name}? Existing subscriptions keep their recorded terms.`,
                              )
                            )
                              void onPlatformControl(
                                "retirePricingCatalog",
                                {
                                  catalogId: catalog.id,
                                  expectedRevision: catalog.revision,
                                },
                                "Pricing catalog retired",
                              ).catch(() => undefined);
                          }}
                        >
                          Retire
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="empty-inline">
                <ShieldCheck />
                <span>
                  <strong>Secure trial defaults are active</strong>
                  <small>
                    Until a dated catalog is created, self-service uses the
                    built-in 14-day trial with 7-day grace and 90-day retention.
                  </small>
                </span>
              </div>
            )}
          </section>
          {platform.lifecycleSimulation ? (
            <details className="card table-card developer-tools">
              <summary className="section-heading compact">
                <div>
                  <p className="eyebrow">Tools</p>
                  <h2>Developer tools</h2>
                </div>
              </summary>
              {platform.lifecycleSimulation.enabled &&
              canManagePlatformControls &&
              onPlatformControl ? (
                <button
                  className="button primary"
                  type="button"
                  disabled={busy}
                  onClick={() => setSimulationDialog({ mode: "create" })}
                >
                  <Sparkles /> Create synthetic tenant
                </button>
              ) : (
                <StatusBadge
                  status={
                    platform.lifecycleSimulation.enabled ? "ready" : "disabled"
                  }
                />
              )}
              <div className="empty-inline">
                <ShieldCheck />
                <span>
                  <strong>Production is permanently excluded.</strong>
                  <small>
                    The simulator only advances disposable tenants it creates and
                    invokes the same lifecycle sweep, notices, retention case, and
                    deletion-approval boundary used by operations.
                  </small>
                </span>
              </div>
              {platform.lifecycleSimulation.enabled
                ? simulationWorkspaces.map((workspace) => {
                    const subscription = platform.subscriptions.find(
                      (item) => item.workspaceId === workspace.id,
                    );
                    const complete =
                      workspace.simulation?.lastState === "pending_deletion";
                    return (
                      <div className="platform-ops-row" key={workspace.id}>
                        <span className="invite-icon danger-icon">
                          <RefreshCw />
                        </span>
                        <span className="member-main">
                          <strong>{workspace.name}</strong>
                          <small>
                            Last state{" "}
                            {workspace.simulation?.lastState
                              ? titleCase(workspace.simulation.lastState)
                              : "unset"}
                            {subscription
                              ? ` · ${titleCase(subscription.access)}`
                              : ""}
                          </small>
                        </span>
                        {complete || !onPlatformControl ? null : (
                          <button
                            className="button secondary small"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              setSimulationDialog({
                                mode: "advance",
                                workspace,
                              })
                            }
                          >
                            Advance state
                          </button>
                        )}
                      </div>
                    );
                  })
                : null}
            </details>
          ) : null}
        </>
      ) : null}

      {section === "ops" ? (
        <>
          <section
            className="platform-summary-strip"
            aria-label="Control-plane summary"
          >
            <article>
              <Mail />
              <span>
                <strong>{platform.notificationFailures.length}</strong>
                <small>delivery failures</small>
              </span>
            </article>
            <article>
              <Trash2 />
              <span>
                <strong>{actionableDeletionCases.length}</strong>
                <small>deletion reviews</small>
              </span>
            </article>
            <article>
              <History />
              <span>
                <strong>{platform.platformAudits.length}</strong>
                <small>audit events</small>
              </span>
            </article>
            <article>
              <Activity />
              <span>
                <strong>{platform.activation.length}</strong>
                <small>activation journeys</small>
              </span>
            </article>
          </section>
          <div className="platform-operations-grid">
          <section className="card table-card">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Delivery failures</p>
                <h2>Notification retry queue</h2>
              </div>
              <CircleAlert />
            </div>
            {platform.notificationFailures.length ? (
              <PlatformPagedList items={platform.notificationFailures}>
                {(visible) =>
                  visible.map((failure) => (
                    <button
                      className="platform-compact-row"
                      type="button"
                      key={failure.id}
                      onClick={() =>
                        openSection("accounts", failure.workspaceId)
                      }
                    >
                      <span className="member-main">
                        <strong>{workspaceName(failure.workspaceId)}</strong>
                        <small>
                          {titleCase(failure.kind)} · last failure{" "}
                          {formatDate(failure.lastFailedAt, true)}
                        </small>
                      </span>
                      <strong>{failure.attempts} attempts</strong>
                    </button>
                  ))
                }
              </PlatformPagedList>
            ) : (
              <div className="platform-empty-state compact">
                <span>
                  <CheckCircle2 />
                </span>
                <strong>Delivery queue is clear</strong>
                <small>No failed notifications are waiting for retry.</small>
              </div>
            )}
          </section>
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
            {actionableDeletionCases.length ? (
              actionableDeletionCases.map((item) => {
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
          <section className="card table-card platform-ops-wide">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Platform audit</p>
                <h2>Recent control-plane changes</h2>
              </div>
              <History />
            </div>
            <PlatformAuditList
              audits={platform.platformAudits}
              workspaceName={workspaceName}
            />
          </section>
          <section className="card table-card">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Activation milestones</p>
                <h2>First-value progress</h2>
              </div>
              <Activity />
            </div>
            {platform.activation.length ? (
              <PlatformPagedList items={platform.activation}>
                {(visible) =>
                  visible.map((activation) => {
                    const achieved = [
                      activation.firstPublishedAt,
                      activation.firstTeammateViewAt,
                      activation.firstTeammateCompletionAt,
                    ].filter(Boolean).length;
                    return (
                      <button
                        className="platform-compact-row"
                        type="button"
                        key={activation.workspaceId}
                        onClick={() =>
                          openSection("accounts", activation.workspaceId)
                        }
                      >
                        <span className="member-main">
                          <strong>{workspaceName(activation.workspaceId)}</strong>
                          <small>
                            {activation.firstPublishedAt
                              ? `Published ${formatDate(activation.firstPublishedAt, true)}`
                              : "Awaiting first publication"}
                          </small>
                        </span>
                        <strong>{achieved}/3</strong>
                      </button>
                    );
                  })
                }
              </PlatformPagedList>
            ) : (
              <p className="empty-copy">No activation events recorded.</p>
            )}
          </section>
          {appointments.length ? (
            <section className="card table-card platform-appointments-card">
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
          </div>
        </>
      ) : null}
      {pricingCatalogOpen && onPlatformControl ? (
        <PricingCatalogDialog
          busy={busy}
          catalog={
            pricingCatalogOpen === "create" ? null : pricingCatalogOpen
          }
          generatedAt={platform.generatedAt}
          onClose={() => setPricingCatalogOpen(null)}
          onSave={async (catalog, input) => {
            if (catalog) {
              await onPlatformControl(
                "updatePricingCatalog",
                {
                  catalogId: catalog.id,
                  expectedRevision: catalog.revision,
                  catalog: input,
                },
                "Pricing catalog updated",
              );
            } else {
              await onPlatformControl(
                "createPricingCatalog",
                { catalog: input },
                "Pricing catalog created",
              );
            }
            setPricingCatalogOpen(null);
          }}
        />
      ) : null}
      {simulationDialog &&
      platform.lifecycleSimulation &&
      onPlatformControl ? (
        <LifecycleSimulationDialog
          busy={busy}
          dialog={simulationDialog}
          states={platform.lifecycleSimulation.states}
          createConfirmation={platform.lifecycleSimulation.createConfirmation}
          onClose={() => setSimulationDialog(null)}
          onRun={async (action, payload) => {
            await onPlatformControl(
              action,
              payload,
              action === "createLifecycleSimulationTenant"
                ? "Synthetic lifecycle tenant created"
                : "Synthetic lifecycle state advanced",
            );
            setSimulationDialog(null);
          }}
        />
      ) : null}
      {betaAccessOpen && onCreateBetaAccess ? (
        <BetaAccessDialog
          busy={busy}
          initialExpiresAt={new Date(platformNow + 14 * 86_400_000)
            .toISOString()
            .slice(0, 10)}
          onClose={() => setBetaAccessOpen(false)}
          onCreate={onCreateBetaAccess}
        />
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

function PricingCatalogDialog({
  busy,
  catalog,
  generatedAt,
  onClose,
  onSave,
}: {
  busy: boolean;
  catalog: PlatformPricingCatalog | null;
  generatedAt: string;
  onClose: () => void;
  onSave: (
    catalog: PlatformPricingCatalog | null,
    input: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const [slug, setSlug] = useState(catalog?.slug ?? "current-trial");
  const [version, setVersion] = useState(
    catalog?.catalogVersion ?? "trial-v1",
  );
  const [name, setName] = useState(catalog?.name ?? "KnowHow trial");
  const [description, setDescription] = useState(
    catalog?.description ??
      "No-card trial with governed capture and support.",
  );
  const [status, setStatus] = useState<"draft" | "scheduled" | "active">(
    catalog?.status === "draft" ||
      catalog?.status === "scheduled" ||
      catalog?.status === "active"
      ? catalog.status
      : "draft",
  );
  const [currency, setCurrency] = useState(catalog?.currency ?? "USD");
  const [effectiveFrom, setEffectiveFrom] = useState(
    (catalog?.effectiveFrom ?? generatedAt).slice(0, 10),
  );
  const [effectiveUntil, setEffectiveUntil] = useState(
    catalog?.effectiveUntil?.slice(0, 10) ?? "",
  );
  const [trialDays, setTrialDays] = useState(catalog?.trial.days ?? 14);
  const [graceDays, setGraceDays] = useState(catalog?.trial.graceDays ?? 7);
  const [retentionDays, setRetentionDays] = useState(
    catalog?.trial.retentionDays ?? 90,
  );
  const [creators, setCreators] = useState(
    catalog?.baseWorkspace.includedActiveCreators ?? 25,
  );
  const [users, setUsers] = useState(
    catalog?.baseWorkspace.includedActiveUsers ?? 100,
  );
  const [storageGb, setStorageGb] = useState(
    (catalog?.baseWorkspace.includedStorageBytes ?? 5_000_000_000) /
      1_000_000_000,
  );
  const amountValue = (value: number | null | undefined) =>
    value === null || value === undefined ? "" : String(value / 100);
  const [baseAmount, setBaseAmount] = useState(
    amountValue(catalog?.baseWorkspace.amountMinor),
  );
  const [creatorAmount, setCreatorAmount] = useState(
    amountValue(catalog?.additionalUsage.creator.amountMinor),
  );
  const [userAmount, setUserAmount] = useState(
    amountValue(catalog?.additionalUsage.user.amountMinor),
  );
  const [storageAmount, setStorageAmount] = useState(
    amountValue(catalog?.additionalUsage.storage.amountMinor),
  );
  const [extensionIncluded, setExtensionIncluded] = useState(
    catalog?.features.some(
      (item) => item.key === "browser_extension" && item.included,
    ) ?? true,
  );
  const [exportsIncluded, setExportsIncluded] = useState(
    catalog?.features.some(
      (item) => item.key === "governed_exports" && item.included,
    ) ?? true,
  );
  const [supportIncluded, setSupportIncluded] = useState(
    catalog?.services.some(
      (item) => item.key === "in_app_support" && item.included,
    ) ?? true,
  );
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const parseMinorAmount = (value: string, label: string) => {
    if (!value.trim()) return null;
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`${label} must be a positive amount or blank.`);
    }
    return Math.round(amount * 100);
  };
  const mergeItem = (
    items: PlatformPricingCatalog["features"],
    item: PlatformPricingCatalog["features"][number],
  ) => [...items.filter((candidate) => candidate.key !== item.key), item];

  return (
    <Modal
      title={catalog ? "Edit pricing catalog" : "Create pricing catalog"}
      eyebrow="MFA-protected commercial control"
      onClose={onClose}
      wide
    >
      <form
        className="modal-form pricing-catalog-form"
        onSubmit={(event) => {
          event.preventDefault();
          setWorking(true);
          setError("");
          try {
            const existingFeatures = catalog?.features ?? [];
            const existingServices = catalog?.services ?? [];
            const features = mergeItem(
              mergeItem(existingFeatures, {
                key: "browser_extension",
                label: "Browser capture extension",
                included: extensionIncluded,
                note: "Capture, redact, review, and pair managed devices.",
              }),
              {
                key: "governed_exports",
                label: "Governed exports",
                included: exportsIncluded,
                note: "Policy-controlled PDF, HTML, and Markdown exports.",
              },
            );
            const services = mergeItem(existingServices, {
              key: "in_app_support",
              label: "In-app support",
              included: supportIncluded,
              note: "One-business-day response target.",
            });
            const input = {
              ...(!catalog ? { slug: slug.trim() } : {}),
              catalogVersion: version.trim(),
              name: name.trim(),
              description: description.trim(),
              status,
              currency: currency.trim().toUpperCase(),
              effectiveFrom: new Date(
                `${effectiveFrom}T00:00:00.000Z`,
              ).toISOString(),
              effectiveUntil: effectiveUntil
                ? new Date(`${effectiveUntil}T23:59:59.999Z`).toISOString()
                : null,
              selfServiceTrial: true,
              trial: { days: trialDays, graceDays, retentionDays },
              baseWorkspace: {
                amountMinor: parseMinorAmount(baseAmount, "Base price"),
                includedActiveCreators: creators,
                includedActiveUsers: users,
                includedStorageBytes: Math.round(storageGb * 1_000_000_000),
              },
              additionalUsage: {
                creator: {
                  amountMinor: parseMinorAmount(
                    creatorAmount,
                    "Creator price",
                  ),
                },
                user: {
                  amountMinor: parseMinorAmount(userAmount, "User price"),
                },
                storage: {
                  amountMinor: parseMinorAmount(
                    storageAmount,
                    "Storage price",
                  ),
                },
              },
              features,
              services,
            };
            void onSave(catalog, input)
              .catch((nextError) => setError(messageFromError(nextError)))
              .finally(() => setWorking(false));
          } catch (nextError) {
            setError(messageFromError(nextError));
            setWorking(false);
          }
        }}
      >
        <div className="settings-grid compact-settings-grid">
          {!catalog ? (
            <label>
              <span>Internal slug</span>
              <input
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                required
              />
            </label>
          ) : null}
          <label>
            <span>Version</span>
            <input
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              required
            />
          </label>
          <label>
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
          <label>
            <span>Status</span>
            <SelectMenu
              className="form-select"
              value={status}
              onChange={(value) =>
                setStatus(
                  value as "draft" | "scheduled" | "active",
                )
              }
              ariaLabel="Catalog status"
              options={[
                { value: "draft", label: "Draft" },
                { value: "scheduled", label: "Scheduled" },
                { value: "active", label: "Active" },
              ]}
            />
          </label>
        </div>
        <label>
          <span>Description</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
          />
        </label>
        <div className="settings-grid compact-settings-grid">
          <label>
            <span>Currency</span>
            <input
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              maxLength={3}
              required
            />
          </label>
          <label>
            <span>Effective from</span>
            <input
              type="date"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
              required
            />
          </label>
          <label>
            <span>Effective until</span>
            <input
              type="date"
              value={effectiveUntil}
              onChange={(event) => setEffectiveUntil(event.target.value)}
            />
          </label>
        </div>
        <div className="settings-grid compact-settings-grid">
          <label>
            <span>Trial days</span>
            <input
              type="number"
              min={1}
              max={90}
              value={trialDays}
              onChange={(event) => setTrialDays(Number(event.target.value))}
              required
            />
          </label>
          <label>
            <span>Grace days</span>
            <input
              type="number"
              min={0}
              max={30}
              value={graceDays}
              onChange={(event) => setGraceDays(Number(event.target.value))}
              required
            />
          </label>
          <label>
            <span>Retention days</span>
            <input
              type="number"
              min={30}
              max={365}
              value={retentionDays}
              onChange={(event) =>
                setRetentionDays(Number(event.target.value))
              }
              required
            />
          </label>
        </div>
        <div className="settings-grid compact-settings-grid">
          <label>
            <span>Included creators</span>
            <input
              type="number"
              min={1}
              value={creators}
              onChange={(event) => setCreators(Number(event.target.value))}
              required
            />
          </label>
          <label>
            <span>Included users</span>
            <input
              type="number"
              min={1}
              value={users}
              onChange={(event) => setUsers(Number(event.target.value))}
              required
            />
          </label>
          <label>
            <span>Included storage (GB)</span>
            <input
              type="number"
              min={0.001}
              step={0.1}
              value={storageGb}
              onChange={(event) => setStorageGb(Number(event.target.value))}
              required
            />
          </label>
        </div>
        <div className="settings-grid compact-settings-grid">
          <label>
            <span>Base monthly price</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={baseAmount}
              onChange={(event) => setBaseAmount(event.target.value)}
              placeholder="Not published"
            />
          </label>
          <label>
            <span>Additional creator</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={creatorAmount}
              onChange={(event) => setCreatorAmount(event.target.value)}
              placeholder="Not published"
            />
          </label>
          <label>
            <span>Additional user</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={userAmount}
              onChange={(event) => setUserAmount(event.target.value)}
              placeholder="Not published"
            />
          </label>
          <label>
            <span>Storage per GB</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={storageAmount}
              onChange={(event) => setStorageAmount(event.target.value)}
              placeholder="Not published"
            />
          </label>
        </div>
        <div className="checkbox-stack">
          <label>
            <input
              type="checkbox"
              checked={extensionIncluded}
              onChange={(event) => setExtensionIncluded(event.target.checked)}
            />
            Browser capture extension included
          </label>
          <label>
            <input
              type="checkbox"
              checked={exportsIncluded}
              onChange={(event) => setExportsIncluded(event.target.checked)}
            />
            Governed exports included
          </label>
          <label>
            <input
              type="checkbox"
              checked={supportIncluded}
              onChange={(event) => setSupportIncluded(event.target.checked)}
            />
            In-app support included
          </label>
        </div>
        <div className="empty-inline">
          <ShieldCheck />
          <span>
            <strong>Security is never an add-on.</strong>
            <small>
              Tenant isolation, MFA, encryption, audit, backup, and retention
              controls stay included. Payment collection remains off.
            </small>
          </span>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button className="button ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || working}
          >
            {working ? <LoaderCircle className="spin" /> : <ShieldCheck />}
            {catalog ? "Save catalog" : "Create catalog"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

type PlatformLifecycleState =
  | "trial_active"
  | "near_expiry"
  | "read_only"
  | "suspended"
  | "retention"
  | "deletion_eligible"
  | "pending_deletion";

function LifecycleSimulationDialog({
  busy,
  dialog,
  states,
  createConfirmation,
  onClose,
  onRun,
}: {
  busy: boolean;
  dialog:
    | { mode: "create" }
    | { mode: "advance"; workspace: PlatformWorkspace };
  states: ReadonlyArray<PlatformLifecycleState>;
  createConfirmation: string;
  onClose: () => void;
  onRun: (
    action: "createLifecycleSimulationTenant" | "simulateLifecycleState",
    payload: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const currentState =
    dialog.mode === "advance"
      ? (dialog.workspace.simulation?.lastState as PlatformLifecycleState) ??
        "trial_active"
      : "trial_active";
  const currentIndex = Math.max(0, states.indexOf(currentState));
  const availableStates = states.slice(currentIndex + 1);
  const [state, setState] = useState<PlatformLifecycleState>(
    availableStates[0] ?? "pending_deletion",
  );
  const [label, setLabel] = useState("Lifecycle QA");
  const [confirmation, setConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const expected =
    dialog.mode === "create"
      ? createConfirmation
      : `SIMULATE ${dialog.workspace.slug} AS ${state.toUpperCase()}`;

  return (
    <Modal
      title={
        dialog.mode === "create"
          ? "Create synthetic lifecycle tenant"
          : "Advance synthetic lifecycle"
      }
      eyebrow="Non-production only"
      onClose={onClose}
    >
      <form
        className="modal-form lifecycle-simulation-form"
        onSubmit={(event) => {
          event.preventDefault();
          setWorking(true);
          setError("");
          const action =
            dialog.mode === "create"
              ? "createLifecycleSimulationTenant"
              : "simulateLifecycleState";
          const payload =
            dialog.mode === "create"
              ? { label: label.trim(), confirmation }
              : {
                  targetWorkspaceId: dialog.workspace.id,
                  state,
                  confirmation,
                };
          void onRun(action, payload)
            .catch((nextError) => setError(messageFromError(nextError)))
            .finally(() => setWorking(false));
        }}
      >
        <div className="empty-inline">
          <CircleAlert />
          <span>
            <strong>Only disposable synthetic records are eligible.</strong>
            <small>
              State changes cannot be rewound. Deletion still requires the
              separate platform-owner approval and purge workflow.
            </small>
          </span>
        </div>
        {dialog.mode === "create" ? (
          <label className="field">
            <span>Simulation label</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              minLength={2}
              maxLength={64}
              required
            />
          </label>
        ) : (
          <label className="field">
            <span>Target state</span>
            <SelectMenu
              className="form-select"
              value={state}
              onChange={(value) => {
                setState(value as PlatformLifecycleState);
                setConfirmation("");
              }}
              ariaLabel="Target lifecycle state"
              options={availableStates.map((candidate) => ({
                value: candidate,
                label: titleCase(candidate),
              }))}
            />
          </label>
        )}
        <label className="field">
          <span>Type this exact confirmation</span>
          <code>{expected}</code>
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button className="button ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={
              busy ||
              working ||
              confirmation !== expected ||
              (dialog.mode === "create" && label.trim().length < 2)
            }
          >
            {working ? <LoaderCircle className="spin" /> : <ShieldCheck />}
            {dialog.mode === "create" ? "Create tenant" : "Advance state"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function BetaAccessDialog({
  busy,
  initialExpiresAt,
  onClose,
  onCreate,
}: {
  busy: boolean;
  initialExpiresAt: string;
  onClose: () => void;
  onCreate: (input: {
    label?: string;
    email?: string;
    expiresAt: string;
    maxUses: number;
  }) => Promise<{ grant: BetaAccessGrant; code: string }>;
}) {
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [expiryDate, setExpiryDate] = useState(initialExpiresAt);
  const [maxUses, setMaxUses] = useState(1);
  const [result, setResult] = useState<{
    grant: BetaAccessGrant;
    code: string;
  } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const registrationLink = result
    ? `${typeof window === "undefined" ? "" : window.location.origin}/register?beta=${encodeURIComponent(result.code)}`
    : "";

  async function copy(value: string, message: string) {
    await navigator.clipboard.writeText(value);
    toast.success(message);
  }

  return (
    <Modal
      title={result ? "Beta access is ready" : "Generate beta access"}
      eyebrow="MFA-protected admission"
      onClose={onClose}
    >
      {result ? (
        <div className="beta-access-result">
          <div className="self-service-ready">
            <CheckCircle2 />
            <span>
              <strong>Copy this credential now.</strong>
              <small>
                Only its hash is stored. Closing this dialog permanently hides
                the code.
              </small>
            </span>
          </div>
          <label className="auth-field">
            <span>Registration link</span>
            <div className="auth-input-wrap beta-access-output">
              <Link2 />
              <input readOnly value={registrationLink} />
              <button
                type="button"
                aria-label="Copy registration link"
                onClick={() =>
                  void copy(registrationLink, "Registration link copied")
                }
              >
                <Copy />
              </button>
            </div>
          </label>
          <label className="auth-field">
            <span>Access code</span>
            <div className="auth-input-wrap beta-access-output">
              <KeyRound />
              <input readOnly value={result.code} />
              <button
                type="button"
                aria-label="Copy beta access code"
                onClick={() =>
                  void copy(result.code, "Beta access code copied")
                }
              >
                <Copy />
              </button>
            </div>
          </label>
          <div className="modal-actions">
            <button className="button primary" type="button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            setWorking(true);
            setError("");
            void onCreate({
              ...(label.trim() ? { label: label.trim() } : {}),
              ...(email.trim() ? { email: email.trim().toLowerCase() } : {}),
              expiresAt: new Date(`${expiryDate}T23:59:59.000Z`).toISOString(),
              maxUses,
            })
              .then(setResult)
              .catch((nextError) =>
                setError(
                  nextError instanceof Error
                    ? nextError.message
                    : "Beta access could not be created.",
                ),
              )
              .finally(() => setWorking(false));
          }}
        >
          <label className="auth-field">
            <span>
              Label <small>Optional internal context</small>
            </span>
            <div className="auth-input-wrap">
              <KeyRound />
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="August design partners"
              />
            </div>
          </label>
          <label className="auth-field">
            <span>
              Approved email <small>Blank allows any recipient</small>
            </span>
            <div className="auth-input-wrap">
              <Mail />
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="tester@company.com"
              />
            </div>
          </label>
          <div className="settings-grid compact-settings-grid">
            <label>
              <span>Expires</span>
              <input
                type="date"
                min={new Date().toISOString().slice(0, 10)}
                value={expiryDate}
                onChange={(event) => setExpiryDate(event.target.value)}
                required
              />
            </label>
            <label>
              <span>Maximum uses</span>
              <input
                type="number"
                min={1}
                max={100}
                value={maxUses}
                onChange={(event) => setMaxUses(Number(event.target.value))}
                required
              />
            </label>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="modal-actions">
            <button className="button ghost" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={busy || working || !expiryDate || maxUses < 1}
            >
              {working ? <LoaderCircle className="spin" /> : <ShieldCheck />}
              Generate one-time code
            </button>
          </div>
        </form>
      )}
    </Modal>
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
    description: "Organization identity and workspace directory",
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
  onRevokeAppointment,
}: {
  organization: OrganizationAdministration;
  busy: boolean;
  onAppoint: (payload: {
    emails: string[];
    roles: OrganizationRole[];
    anchorWorkspaceId: string;
  }) => Promise<
    Array<{
      email: string;
      appointmentToken: string;
      expiresAt: string;
    }>
  >;
  onUpdate: (
    memberId: string,
    roles: OrganizationRole[],
    status: "active" | "revoked",
  ) => Promise<unknown>;
  onRevokeAppointment: (appointmentId: string) => Promise<unknown>;
}) {
  const [appointing, setAppointing] = useState(false);
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
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
            People and workspaces for this company. Organization roles do not
            grant access to guides.
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
            <h2>{organization.legalName || organization.displayName}</h2>
            <p>
              Legal name · {organization.country} ·{" "}
              {titleCase(organization.status)} · your roles:{" "}
              {organization.roles.map(titleCase).join(", ")}
            </p>
          </div>
        </div>
        <p className="privacy-caption">
          <LockKeyhole /> Organization administrators manage people. They do
          not automatically see workspace guides.
        </p>
      </section>
      <section className="card table-card">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Workspace directory</p>
            <h2>
              {countPhrase(organization.workspaces.length, "workspace")}
            </h2>
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
                {workspace.slug}
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
              <h2>
                {countPhrase(organization.members.length, "organization member")}
              </h2>
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
  onAppoint: (payload: {
    emails: string[];
    roles: OrganizationRole[];
    anchorWorkspaceId: string;
  }) => Promise<
    Array<{
      email: string;
      appointmentToken: string;
      expiresAt: string;
    }>
  >;
}) {
  const [emailDraft, setEmailDraft] = useState("");
  const [roles, setRoles] = useState<OrganizationRole[]>(["administrator"]);
  const [workspaceId, setWorkspaceId] = useState(
    organization.workspaces[0]?.id ?? "",
  );
  const [created, setCreated] = useState<
    Array<{ email: string; appointmentToken: string; expiresAt: string }>
  >([]);
  const [error, setError] = useState("");
  const parsed = parseInviteEmails(emailDraft);
  const overLimit = parsed.emails.length > MAX_BULK_INVITES;
  const origin =
    typeof window === "undefined" ? "" : window.location.origin;

  return (
    <Modal
      title="Appoint organization member"
      eyebrow="Email-bound governance role"
      onClose={onClose}
      wide
    >
      {created.length ? (
        <div className="modal-form invite-form created-invite">
          <CheckCircle2 />
          <div>
            <strong>
              {created.length === 1
                ? "Appointment queued"
                : `${created.length} appointments queued`}
            </strong>
            <p>
              Each fallback credential is shown once. Copy the links now.
            </p>
          </div>
          <div className="created-invite-list">
            {created.map((item) => {
              const url = `${origin}/app?appointment=${encodeURIComponent(item.appointmentToken)}`;
              return (
                <div className="copy-field" key={item.email}>
                  <span className="created-invite-email">{item.email}</span>
                  <input
                    readOnly
                    value={url}
                    aria-label={`${item.email} appointment link`}
                  />
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => navigator.clipboard.writeText(url)}
                  >
                    <Copy /> Copy
                  </button>
                </div>
              );
            })}
          </div>
          {created.length > 1 ? (
            <button
              className="button ghost small"
              type="button"
              onClick={() =>
                navigator.clipboard.writeText(
                  created
                    .map(
                      (item) =>
                        `${item.email}\t${origin}/app?appointment=${encodeURIComponent(item.appointmentToken)}`,
                    )
                    .join("\n"),
                )
              }
            >
              <Copy /> Copy all links
            </button>
          ) : null}
          <footer className="modal-footer">
            <span />
            <button className="button primary" type="button" onClick={onClose}>
              Done
            </button>
          </footer>
        </div>
      ) : (
        <form
          className="modal-form invite-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              !parsed.emails.length ||
              parsed.invalid.length ||
              overLimit ||
              !roles.length ||
              !workspaceId
            ) {
              return;
            }
            setError("");
            try {
              const result = await onAppoint({
                emails: parsed.emails,
                roles,
                anchorWorkspaceId: workspaceId,
              });
              if (result.length) setCreated(result);
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
            <span>Verified account emails</span>
            <textarea
              required
              className="invite-emails"
              value={emailDraft}
              onChange={(event) => setEmailDraft(event.target.value)}
              placeholder={"owner@example.com\nbilling@example.com"}
              aria-label="Verified account emails"
              rows={6}
            />
            <small>
              Paste one address per line, or separate them with commas. Each
              person must already have that verified account.
              {parsed.emails.length
                ? ` ${countPhrase(parsed.emails.length, "address")} ready.`
                : ""}
            </small>
            {parsed.invalid.length ? (
              <small className="form-error" role="alert">
                Not valid: {parsed.invalid.slice(0, 6).join(", ")}
                {parsed.invalid.length > 6
                  ? ` +${parsed.invalid.length - 6} more`
                  : ""}
              </small>
            ) : null}
            {overLimit ? (
              <small className="form-error" role="alert">
                Appoint at most {MAX_BULK_INVITES} people at a time.
              </small>
            ) : null}
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
            <span>Audit workspace</span>
            <SelectMenu
              className="form-select"
              value={workspaceId}
              onChange={setWorkspaceId}
              ariaLabel="Audit workspace"
              options={organization.workspaces.map((workspace) => ({
                value: workspace.id,
                label: workspaceOptionLabel(workspace),
              }))}
            />
            <small>
              Used only to locate the audit event. It does not grant workspace
              access.
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
                busy ||
                !parsed.emails.length ||
                parsed.invalid.length > 0 ||
                overLimit ||
                !roles.length ||
                !workspaceId
              }
            >
              <UserPlus />{" "}
              {parsed.emails.length > 1
                ? `Create ${parsed.emails.length} appointments`
                : "Create appointment"}
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

function PlatformGlobalSearch({
  platform,
  onNavigate,
}: {
  platform: NonNullable<BootstrapResponse["platform"]>;
  onNavigate: (href: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const results = useMemo(() => {
    const phrase = query.trim().toLowerCase();
    const navigation = PLATFORM_NAV.filter(
      (item) =>
        !phrase ||
        item.label.toLowerCase().includes(phrase) ||
        item.section.toLowerCase().includes(phrase),
    ).map((item) => ({
      key: `section:${item.section}`,
      label: item.label,
      description:
        item.section === "overview"
          ? "Platform command center"
          : `Open platform ${item.label.toLowerCase()}`,
      href: platformHref(item.section),
      icon: item.icon,
      kind: "Section",
    }));
    const workspaces = platform.workspaces
      .filter((workspace) => {
        if (!phrase) return false;
        const administrators = workspace.administrators
          .map((admin) => `${admin.name} ${admin.email}`)
          .join(" ");
        return `${workspace.name} ${workspace.slug} ${administrators}`
          .toLowerCase()
          .includes(phrase);
      })
      .map((workspace) => ({
        key: `workspace:${workspace.id}`,
        label: workspace.name,
        description: `${workspace.slug} · ${countPhrase(workspace.memberCount, "member")}`,
        href: platformHref("accounts", workspace.id),
        icon: Building2,
        kind: "Account",
      }));

    return [...workspaces, ...navigation].slice(0, 8);
  }, [platform.workspaces, query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function openResult(href: string) {
    setOpen(false);
    setQuery("");
    onNavigate(href);
  }

  return (
    <div className="global-search platform-global-search" ref={box}>
      <label className="search-field global-search-field">
        <Search />
        <input
          ref={input}
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
            if (event.key === "Enter" && results[0]) {
              event.preventDefault();
              openResult(results[0].href);
            }
          }}
          placeholder="Search accounts, admins, or platform sections"
          aria-label="Search the platform console"
        />
        <kbd aria-hidden="true">Ctrl K</kbd>
      </label>
      {open ? (
        <div
          className="search-results platform-search-results"
          role="listbox"
          aria-label="Platform search results"
        >
          <p className="search-result-count">
            {query.trim() ? "Best matches" : "Jump to a platform section"}
          </p>
          {results.length ? (
            results.map((result) => {
              const Icon = result.icon;
              return (
                <button
                  className="search-result platform-search-result"
                  type="button"
                  key={result.key}
                  onClick={() => openResult(result.href)}
                >
                  <span className="guide-icon">
                    <Icon />
                  </span>
                  <span className="search-result-main">
                    <span className="guide-title-line">
                      <strong>{result.label}</strong>
                      <span className="workspace-label">{result.kind}</span>
                    </span>
                    <small>{result.description}</small>
                  </span>
                  <ArrowRight />
                </button>
              );
            })
          ) : (
            <p className="search-empty">
              No accounts or sections match &ldquo;{query.trim()}&rdquo;.
            </p>
          )}
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
  state: "checking" | "missing" | "error" | "unavailable" | "connected";
  onClose: () => void;
  onLink: (options?: { force?: boolean }) => Promise<unknown>;
  onRevoke: () => Promise<void>;
}) {
  const [connectionError, setConnectionError] = useState("");
  const stores = extensionStoreUrls();

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
                {stores.chrome || stores.edge
                  ? "Add it from Chrome or Edge, then come back here to connect it to this workspace."
                  : "Download it, load it in Chrome or Edge, then come back here to connect it to this workspace."}
              </p>
              <ExtensionInstallInstructions
                actionClassName="button primary"
                showPageLink
              />
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Connect it to this workspace</strong>
              <p>
                After it is installed, KnowHow pairs it automatically while you
                are signed in. There is no code to copy.
              </p>
              {state === "checking" ? (
                <button className="button primary" disabled>
                  <LoaderCircle className="spin" /> Checking extension
                </button>
              ) : state === "connected" ? (
                <span className="extension-connected">
                  <CheckCircle2 /> Connected to {companion.workspaceName}
                </span>
              ) : (
                <button
                  className="button primary"
                  type="button"
                  disabled={busy || state === "unavailable"}
                  onClick={() => {
                    void relink();
                  }}
                >
                  <Link2 /> Try again
                </button>
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
                <Trash2 /> Disconnect this browser
              </button>
            </div>
          </li>
        </ol>
        {state === "unavailable" ? (
          <p className="form-error">
            This browser cannot run extensions. Install KnowHow Capture in
            Chrome or Edge, then open this workspace there.
          </p>
        ) : null}
        {state === "missing" ? (
          <p className="form-error">
            KnowHow could not find the capture extension. Install it
            {stores.chrome || stores.edge
              ? " from the store"
              : " with the download above"}
            , then try again.
          </p>
        ) : null}
        {state === "error" ? (
          <p className="form-error">
            The extension is installed, but pairing did not finish. Reload the
            extension, then try again.
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

function AccountSecurityDialog({
  name,
  email,
  mfaEnabled,
  onClose,
  onEnable,
}: {
  name: string;
  email: string;
  mfaEnabled: boolean;
  onClose: () => void;
  onEnable: () => void;
}) {
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [displayName, setDisplayName] = useState(name);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

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

  async function turnOff() {
    if (
      !window.confirm(
        "Turn off authenticator protection? You will only need your password to sign in.",
      )
    ) {
      return;
    }
    setWorking(true);
    setError("");
    try {
      await disableMfa();
      toast.success("Authenticator protection is off");
      onClose();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setWorking(false);
    }
  }

  async function saveName() {
    setWorking(true);
    setError("");
    try {
      await updateAccountName(displayName.trim());
      toast.success("Name updated");
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setWorking(false);
    }
  }

  async function savePassword() {
    if (nextPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (nextPassword !== confirmPassword) {
      setError("The two new passwords do not match.");
      return;
    }
    setWorking(true);
    setError("");
    try {
      await updateAccountPassword(currentPassword, nextPassword);
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      toast.success("Password updated");
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setWorking(false);
    }
  }

  async function signOutOtherDevices() {
    if (
      !window.confirm(
        "Sign out every other browser and device? This session will stay signed in.",
      )
    ) {
      return;
    }
    setWorking(true);
    setError("");
    try {
      await revokeOtherSessions();
      toast.success("Other sessions signed out");
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal
      title="Account settings"
      eyebrow={email}
      onClose={onClose}
      wide
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
            <label className="field">
              <span>Name</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <button
              className="button secondary small"
              type="button"
              disabled={working || displayName.trim().length < 2}
              onClick={() => void saveName()}
            >
              Save name
            </button>
            <label className="field">
              <span>Current password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
            <label className="field">
              <span>New password</span>
              <input
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={nextPassword}
                onChange={(event) => setNextPassword(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Confirm new password</span>
              <input
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </label>
            <button
              className="button secondary small"
              type="button"
              disabled={working || !currentPassword || !nextPassword}
              onClick={() => void savePassword()}
            >
              Update password
            </button>
            <p className="modal-copy">
              {mfaEnabled
                ? "Authenticator sign-in is on for this account. You can replace recovery codes or turn it off."
                : "Authenticator apps are optional. Turn one on if you want a second step at sign-in."}
            </p>
            <p className="privacy-caption">
              <LockKeyhole /> Recovery codes are shown once and never included
              in logs, email, or support records.
            </p>
            <button
              className="button ghost small"
              type="button"
              disabled={working}
              onClick={() => void signOutOtherDevices()}
            >
              Sign out other devices
            </button>
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
            {recoveryCodes.length ? "I saved the codes" : "Close"}
          </button>
          {!recoveryCodes.length && mfaEnabled ? (
            <>
              <button
                className="button ghost"
                type="button"
                disabled={working}
                onClick={() => void turnOff()}
              >
                Turn off
              </button>
              <button
                className="button primary"
                type="button"
                disabled={working}
                onClick={() => void regenerate()}
              >
                {working ? <LoaderCircle className="spin" /> : <RotateCcw />}{" "}
                Regenerate codes
              </button>
            </>
          ) : null}
          {!recoveryCodes.length && !mfaEnabled ? (
            <button
              className="button primary"
              type="button"
              disabled={working}
              onClick={onEnable}
            >
              <ShieldCheck /> Turn on authenticator
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
  onRequestMfaEnrollment,
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
  onRequestMfaEnrollment?: () => void;
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
  const platformSection =
    route.kind === "platform" ? route.section : "overview";
  const platformAccountId =
    route.kind === "platform" ? route.workspaceId : undefined;

  const [extensionLink, setExtensionLink] = useState<
    "checking" | "missing" | "error" | "unavailable" | "connected"
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
      try {
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
        if (!state.installed) {
          setExtensionLink(state.reason);
          return state;
        }
        setExtensionLink("connected");
        return state;
      } catch (error) {
        setExtensionLink("error");
        throw error;
      }
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
      void attempt.catch(() => {
        setExtensionLink((current) =>
          current === "checking" ? "missing" : current,
        );
      });
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
      if (item.view === "Capture") return canCapture;
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
      !["Overview", "Guides", "Capture", "Support", "Platform"].includes(item),
  );
  const platformNavigation = visibleNav.filter(
    ({ view: item }) => item === "Platform",
  );
  const onboardingAudience = isAdmin || canCapture;
  const onboardingRemaining = active.onboarding.steps.filter(
    (step) => !step.completed,
  ).length;
  const showSetupNav =
    onboardingAudience &&
    !active.onboarding.completedAt &&
    Boolean(active.onboarding.dismissedAt);
  const accessLabel =
    view === "Platform"
      ? "Platform administrator"
      : workspaceAccessLabel(roles);
  const platformNavCounts: Partial<Record<PlatformSection, number>> =
    data.platform
      ? {
          leads: data.platform.leads.filter(
            (lead) => !["closed", "converted", "rejected"].includes(lead.status),
          ).length,
          accounts: data.platform.workspaces.length,
          support: data.platform.support.filter(
            (ticket) => ticket.status !== "closed",
          ).length,
          billing: data.platform.systemHealth.expiringWithinSevenDays,
          ops:
            data.platform.systemHealth.failedNotifications +
            data.platform.systemHealth.deletionApprovals +
            data.platform.systemHealth.failedOperations,
        }
      : {};

  let primaryAction: {
    label: string;
    icon: typeof Plus;
    disabled: boolean;
    onClick: () => void;
  } | null = null;

  if (view === "Platform" && data.viewer.platformAdministrator) {
    primaryAction = {
      label: "Provision organization",
      icon: Building2,
      disabled: busy,
      onClick: () => setDialog({ type: "platform-create" }),
    };
  } else if (view === "Members" && isAdmin) {
    primaryAction = {
      label: "Invite teammate",
      icon: UserPlus,
      disabled: busy || !workspaceMutable,
      onClick: () => setDialog({ type: "invite" }),
    };
  } else if (view === "Groups" && isAdmin) {
    primaryAction = {
      label: "New group",
      icon: Group,
      disabled: busy || !workspaceMutable,
      onClick: () => setDialog({ type: "group", group: null }),
    };
  } else if (
    (view === "Overview" || view === "Guides") &&
    canCreate &&
    workspaceMutable
  ) {
    primaryAction = {
      label: "New guide",
      icon: Plus,
      disabled: busy,
      onClick: () => onNavigate(newGuideHref(workspace.slug)),
    };
  } else if (view === "Capture" && canCapture) {
    primaryAction = {
      label: "Install and pair",
      icon: Sparkles,
      disabled: busy,
      onClick: () => setDialog({ type: "extension" }),
    };
  } else if (view === "Vault" && canUseVault) {
    primaryAction = {
      label: "New vault item",
      icon: KeyRound,
      disabled: busy || !workspaceMutable,
      onClick: () => setDialog({ type: "vault-editor", item: null }),
    };
  }
  const PrimaryActionIcon = primaryAction?.icon;

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
        className="app-shell experience-shell"
        data-view={view.toLowerCase()}
        data-access={
          view === "Platform"
            ? "platform"
            : isAdmin
              ? "administrator"
              : canCreate
                ? "contributor"
                : "member"
        }
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
            {view === "Platform" ? (
              <div className="platform-sidebar-context">
                <span className="platform-sidebar-context-icon">
                  <ShieldCheck />
                </span>
                <span>
                  <small>Platform console</small>
                  <strong>All workspaces</strong>
                </span>
                <StatusBadge status="active" />
              </div>
            ) : (
              <>
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
                        <small>{workspaceAccessLabel(roles)}</small>
                      </span>
                    </>
                  )}
                />
              </>
            )}
          </SidebarHeader>
          <SidebarContent>
            {view === "Platform" ? (
              <>
                <SidebarGroup className="workspace-nav-group">
                  <nav className="main-nav" aria-label="Leave platform console">
                    <SidebarMenu>
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          type="button"
                          onClick={() =>
                            onNavigate(workspaceHref(workspace.slug))
                          }
                        >
                          <ArrowLeft />
                          <span>Back to {workspace.name}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </nav>
                </SidebarGroup>
              <SidebarGroup className="workspace-nav-group">
                <p className="sidebar-section-label">Platform</p>
                <nav className="main-nav" aria-label="Platform navigation">
                  <SidebarMenu>
                    {PLATFORM_NAV.map((item) => {
                      const Icon = item.icon;
                      return (
                        <SidebarMenuItem key={item.section}>
                          <SidebarMenuButton
                            isActive={platformSection === item.section}
                            type="button"
                            onClick={() => onNavigate(platformHref(item.section))}
                          >
                            <Icon />
                            <span>{item.label}</span>
                          </SidebarMenuButton>
                          {platformNavCounts[item.section] ? (
                            <SidebarMenuBadge>
                              {platformNavCounts[item.section]}
                            </SidebarMenuBadge>
                          ) : null}
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </nav>
              </SidebarGroup>
              </>
            ) : (
              <>
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
                        <span>{NAV_LABELS[item]}</span>
                      </SidebarMenuButton>
                      {item === "Guides" && active.metrics.reviews ? (
                        <SidebarMenuBadge>
                          {active.metrics.reviews}
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  ))}
                  {showSetupNav ? (
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={dialog?.type === "setup-wizard"}
                        type="button"
                        onClick={() => setDialog({ type: "setup-wizard" })}
                      >
                        <ClipboardCheck />
                        <span>Getting started</span>
                      </SidebarMenuButton>
                      {onboardingRemaining ? (
                        <SidebarMenuBadge>{onboardingRemaining}</SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  ) : null}
                </SidebarMenu>
              </nav>
            </SidebarGroup>
            {governanceNavigation.length ? (
              <SidebarGroup className="workspace-nav-group governance-nav-group">
                <p className="sidebar-section-label">Manage workspace</p>
                <nav
                  className="main-nav"
                  aria-label="Workspace administration navigation"
                >
                  <SidebarMenu>
                    {governanceNavigation.map(({ view: item, icon: Icon }) => (
                      <SidebarMenuItem key={item}>
                        <SidebarMenuButton
                          isActive={view === item}
                          type="button"
                          onClick={() => navigateToView(item)}
                        >
                          <Icon />
                          <span>{NAV_LABELS[item]}</span>
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
            {platformNavigation.length ? (
              <SidebarGroup className="workspace-nav-group admin-nav-group">
                <p className="sidebar-section-label">Administration</p>
                <nav className="main-nav" aria-label="Platform navigation">
                  <SidebarMenu>
                    {platformNavigation.map(({ view: item, icon: Icon }) => (
                      <SidebarMenuItem key={item}>
                        <SidebarMenuButton
                          isActive={view === item}
                          type="button"
                          onClick={() => navigateToView(item)}
                        >
                          <Icon />
                          <span>{NAV_LABELS[item]}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </nav>
              </SidebarGroup>
            ) : null}
              </>
            )}
          </SidebarContent>
          {canCapture && view !== "Platform" ? (
            <SidebarFooter>
              <button
                className="capture-shortcut"
                type="button"
                onClick={() => setDialog({ type: "extension" })}
              >
                <span>
                  <Sparkles />
                </span>
                <span>
                  <strong>Capture workflow</strong>
                  <small>Chrome & Edge extension</small>
                </span>
                <ArrowRight />
              </button>
            </SidebarFooter>
          ) : null}
        </Sidebar>

        <div className="app-main">
          <header className="topbar">
            <div className="topbar-start">
              <SidebarTrigger className="mobile-menu" />
              <div className="topbar-workspace">
                {view === "Platform" ? (
                  <span className="topbar-context-mark" aria-hidden="true">
                    <Shield />
                  </span>
                ) : (
                  <WorkspaceLogo
                    workspaceId={workspace.id}
                    workspaceName={workspace.name}
                    logoKey={workspace.settings.logoUrl}
                    size="sm"
                  />
                )}
                <span className="topbar-context-copy">
                  <small>
                    {view === "Platform"
                      ? (PLATFORM_NAV.find((item) => item.section === platformSection)
                          ?.label ?? "Platform")
                      : NAV_LABELS[view]}
                  </small>
                  <strong>
                    {view === "Platform"
                      ? "KnowHow administration"
                      : workspace.name}
                  </strong>
                  {view !== "Platform" ? (
                    <TrialChip subscription={workspace.subscription} />
                  ) : null}
                </span>
              </div>
            </div>
            <div className="topbar-search-slot">
              {view === "Platform" && data.platform ? (
                <PlatformGlobalSearch
                  platform={data.platform}
                  onNavigate={onNavigate}
                />
              ) : guides.length &&
                !["Organization", "Settings", "Support"].includes(view) ? (
                <GlobalGuideSearch guides={guides} onOpen={openGuide} />
              ) : null}
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
              {primaryAction && PrimaryActionIcon ? (
                <Button
                  className="top-create topbar-primary-action"
                  size="sm"
                  type="button"
                  disabled={primaryAction.disabled}
                  onClick={primaryAction.onClick}
                >
                  <PrimaryActionIcon /> {primaryAction.label}
                </Button>
              ) : null}
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
                      <span className="profile-access-context">
                        {accessLabel}
                      </span>
                    </DropdownMenuLabel>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setDialog({ type: "account-security" })}
                  >
                    <KeyRound /> Account settings
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
                onOpenExtension={() => setDialog({ type: "extension" })}
                onDismiss={() =>
                  command("dismissOnboarding", {}, "").then(() => undefined)
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
              <CaptureView canCapture={canCapture} />
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
                onAppoint={async ({ emails, roles, anchorWorkspaceId }) => {
                  onBusyChange(true);
                  onError("");
                  const created: Array<{
                    email: string;
                    appointmentToken: string;
                    expiresAt: string;
                  }> = [];
                  try {
                    for (const email of emails) {
                      const result = await knowhowCommand<{
                        appointmentId: string;
                        appointmentToken: string;
                        expiresAt: string;
                      }>("appointOrganizationMember", {
                        organizationId: organization.id,
                        email,
                        roles,
                        anchorWorkspaceId,
                      });
                      created.push({
                        email,
                        appointmentToken: result.appointmentToken,
                        expiresAt: result.expiresAt,
                      });
                    }
                    await onRefresh();
                    toast.success(
                      created.length === 1
                        ? "Organization appointment created"
                        : `${created.length} organization appointments created`,
                    );
                    return created;
                  } catch (error) {
                    if (created.length) await onRefresh();
                    const suffix = created.length
                      ? ` Created ${created.length} of ${emails.length}.`
                      : "";
                    onError(`${messageFromError(error)}${suffix}`);
                    if (created.length) return created;
                    throw error;
                  } finally {
                    onBusyChange(false);
                  }
                }}
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
                onRefresh={onRefresh}
                onSave={async (settings) => {
                  await command(
                    "updateWorkspaceSettings",
                    { settings },
                    "Workspace settings saved",
                  );
                }}
              />
            ) : null}
            {view === "Platform" &&
            data.viewer.platformAdministrator &&
            data.platform ? (
              <PlatformView
                key={`${platformSection}:${platformAccountId ?? "all"}`}
                platform={data.platform}
                busy={busy}
                section={platformSection}
                workspaceId={platformAccountId}
                onNavigate={onNavigate}
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
                canManageBetaAccess={Boolean(
                  data.viewer.platformRoles?.some((role) =>
                    ["owner", "operations"].includes(role),
                  ),
                )}
                onCreateBetaAccess={async (input) => {
                  return command(
                    "createBetaAccessGrant",
                    input,
                    "Private-beta access generated",
                  ) as Promise<{ grant: BetaAccessGrant; code: string }>;
                }}
                onRevokeBetaAccess={(grantId) =>
                  command(
                    "revokeBetaAccessGrant",
                    { grantId },
                    "Private-beta access revoked",
                  )
                }
                canManagePlatformControls={Boolean(
                  data.viewer.platformRoles?.some((role) =>
                    ["owner", "operations"].includes(role),
                  ),
                )}
                onPlatformControl={(action, payload, successMessage) =>
                  command(action, payload, successMessage)
                }
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
            onCreate={async (payload) => {
              onBusyChange(true);
              onError("");
              const created: Array<{ email: string; token: string }> = [];
              try {
                for (const email of payload.emails) {
                  const label = (
                    payload.label || `Invite ${email}`
                  ).slice(0, 128);
                  const result = await knowhowCommand<{ token: string }>(
                    "createInvite",
                    {
                      workspaceId: workspace.id,
                      email,
                      label,
                      role: payload.role,
                      expiresInHours: payload.expiresInHours,
                      maxUses: 1,
                    },
                  );
                  created.push({ email, token: result.token });
                }
                await onRefresh();
                toast.success(
                  created.length === 1
                    ? "Invitation created"
                    : `${created.length} invitations created`,
                );
                return created;
              } catch (error) {
                if (created.length) await onRefresh();
                const suffix = created.length
                  ? ` Created ${created.length} of ${payload.emails.length}.`
                  : "";
                onError(`${messageFromError(error)}${suffix}`);
                if (created.length) return created;
                throw error;
              } finally {
                onBusyChange(false);
              }
            }}
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
        {dialog?.type === "setup-wizard" && onboardingAudience ? (
          <Modal
            title="Getting started"
            eyebrow="Workspace setup"
            onClose={() => setDialog(null)}
          >
            <SetupWizard
              onboarding={active.onboarding}
              busy={busy}
              canCapture={canCapture}
              canManageAccess={isAdmin}
              chrome="plain"
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
              onNavigate={(nextView) => {
                setDialog(null);
                navigateToView(nextView);
              }}
              onOpenExtension={() => setDialog({ type: "extension" })}
              onDismiss={() =>
                command("dismissOnboarding", {}, "").then(() => {
                  setDialog(null);
                })
              }
            />
          </Modal>
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
            onComplete={(runId, finalStepData) =>
              command<PlatformProvisioningResult>(
                "completeProvisioningRun",
                { runId, finalStepData },
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
          <AccountSecurityDialog
            name={data.viewer.name}
            email={data.viewer.email}
            mfaEnabled={Boolean(data.viewer.mfaEnabled)}
            onClose={() => setDialog(null)}
            onEnable={() => {
              setDialog(null);
              onRequestMfaEnrollment?.();
            }}
          />
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
  onComplete: (
    runId: string,
    finalStepData: Record<string, unknown>,
  ) => Promise<PlatformProvisioningResult>;
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
      if (complete) {
        if (!runId) {
          throw new Error(
            "Save organization identity before completing provisioning.",
          );
        }
        setCreated(await onComplete(runId, stepData(step)));
        return;
      }
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
        else setStep(3);
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
      if (closeAfterSave) {
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
      title="Provision an organization"
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
            invitations, groups, and support governance.
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

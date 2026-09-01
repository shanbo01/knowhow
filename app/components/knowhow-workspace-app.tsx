"use client";

import {
  Archive,
  ArchiveRestore,
  Pencil,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  BookOpen,
  Building2,
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
  FilterX,
  Globe2,
  Grid2X2,
  Group,
  ImagePlus,
  KeyRound,
  LayoutDashboard,
  Laptop,
  LifeBuoy,
  Link2,
  List,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Mail,
  MoreHorizontal,
  Moon,
  Paintbrush,
  Paperclip,
  PenLine,
  Plus,
  RotateCcw,
  Rows2,
  Rows3,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  UserCheck,
  UserCog,
  Undo2,
  UserPlus,
  Users,
  Pin,
  X,
} from "lucide-react";
import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { GuideFavicon } from "./guide-favicon";
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
  removeStagedSupportAttachment,
  supportAttachmentHref,
  knowhowCommand,
  uploadSupportAttachment,
  uploadProvisioningLogo,
  uploadWorkspaceLogo,
  KnowHowApiError,
} from "../../lib/knowhow-client";
import type { NavigationGuard } from "../../lib/navigation-guard";
import { isCapturedGuideSource } from "../../lib/guide-contracts";
import {
  companionGuidesFromWorkspace,
  ensureKnowHowExtension,
  extensionStoreUrls,
  syncKnowHowExtension,
  type ExtensionCompanion,
} from "../../lib/extension-bridge";
import type {
  Audience,
  BootstrapResponse,
  DesktopCaptureDevice,
  Guide,
  GuideRevisionView,
  GuideSearchResult,
  Invitation,
  OrganizationAdministration,
  OrganizationRole,
  PlatformProvisioningResult,
  PlatformProvisioningRun,
  SupportAccessGrant,
  SupportAccessRequest,
  SupportTicket,
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
  administrationClientHref,
  workspaceHref,
  type AppRoute,
  type GuideRevisionMode,
  type WorkspaceSection,
} from "../../lib/workspace-routes";
import { useTheme } from "./theme-provider";
import {
  GuideEditor,
  type GuideEditorPayload,
  type GuideSaveResult,
} from "./guide-editor";
import { GuideShareDialog } from "./guide-share-dialog";
import { GuideExportDialog, type GuideExportFormatChoice } from "./guide-export-dialog";
import { GuideDeleteDialog } from "./guide-delete-dialog";
import { GuideReaderView } from "./guide-reader-view";
import { GuideCreateMenu } from "./guide-create-menu";
import { ProBadge, ProUpsell } from "./pro-badge";
import { UsageMeter, usageTone } from "./plan-usage";
import { useConfirmDialog } from "./confirm-dialog";
import { HexColorPicker, isValidHexColor } from "./hex-color-picker";
import { SelectMenu } from "./select-menu";
import { ProductBrand } from "./product-brand";
import { WorkspaceLogo } from "./workspace-logo";
import { ExtensionInstallInstructions } from "./extension-install-instructions";
import { PolicyNote } from "./workspace-patterns";
import { AdministrationView } from "./administration/administration-view";
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
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
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
  | "Groups"
  | "Members"
  | "Support"
  | "Organization"
  | "Settings"
  | "Administration";

type DialogState =
  | null
  | { type: "group"; group: WorkspaceGroup | null }
  | { type: "invite" }
  | { type: "plan" }
  | { type: "entitlement"; kind: string; message: string }
  | { type: "member"; member: WorkspaceMember }
  | { type: "extension" }
  | { type: "desktop" }
  | { type: "share-guide"; guides: Guide[] }
  | { type: "export-guide"; guides: Guide[] }
  | { type: "account-security" }
  | { type: "support-decision"; request: SupportAccessRequest };

const NAV_ITEMS: Array<{ view: View; icon: typeof LayoutDashboard }> = [
  { view: "Overview", icon: LayoutDashboard },
  { view: "Guides", icon: BookOpen },
  { view: "Groups", icon: Group },
  { view: "Members", icon: Users },
  { view: "Support", icon: LifeBuoy },
  { view: "Organization", icon: Building2 },
  { view: "Settings", icon: Settings },
];

const NAV_LABELS: Record<View, string> = {
  Overview: "Home",
  Guides: "Library",
  Groups: "Groups",
  Members: "People & access",
  Support: "Support",
  Organization: "Organization",
  Settings: "Workspace settings",
  Administration: "KnowHow Administration",
};

const VIEW_TO_SECTION: Record<View, WorkspaceSection> = {
  Overview: "overview",
  Guides: "guides",
  Groups: "groups",
  Members: "members",
  Support: "support",
  Organization: "organization",
  Settings: "settings",
  Administration: "administration",
};

const SECTION_TO_VIEW: Record<WorkspaceSection, View> = {
  overview: "Overview",
  guides: "Guides",
  capture: "Guides",
  groups: "Groups",
  members: "Members",
  support: "Support",
  organization: "Organization",
  settings: "Settings",
  administration: "Administration",
};

const ROLE_COPY: Record<WorkspaceRole, string> = {
  administrator: "Manage workspace settings, people, groups, and audit; does not grant guide access",
  creator: "Create and edit their own private drafts",
  reviewer: "Read and decide only assigned review drafts",
  publisher: "Publish approved revisions and archive guides",
  viewer: "Read published guides shared with them",
};

function workspaceRoleLabel(role: WorkspaceRole) {
  if (role === "administrator") return "Administrator";
  return titleCase(role);
}

function organizationRoleLabel(role: OrganizationRole) {
  if (role === "owner") return "Owner";
  if (role === "administrator") return "Administrator";
  return titleCase(role);
}

function workspaceAccessLabel(roles: WorkspaceRole[]) {
  if (roles.includes("administrator")) return "Workspace administrator";

  const operationalRoles = (
    ["creator", "reviewer", "publisher"] as WorkspaceRole[]
  ).filter((role) => roles.includes(role));
  if (operationalRoles.length) {
    return operationalRoles.map(workspaceRoleLabel).join(" · ");
  }

  return "Viewer";
}

function messageFromError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The operation could not be completed.";
}

const ENTITLEMENT_COPY: Record<string, string> = {
  maximumGuides:
    "This workspace has reached its guide limit. Archive a guide to free a slot, or upgrade for more.",
  maximumUsers: "This workspace has reached its limit on people.",
  maximumCreators: "This workspace has reached its limit on creators.",
  storageBytes: "This workspace has reached its storage limit.",
  extensionEnabled: "Browser extension capture is unavailable in this workspace.",
  desktopCaptureEnabled: "Windows desktop capture is a Pro feature.",
  privacyToolsEnabled:
    "Editor blur and annotations, plus extension Auto Blur, are Pro features.",
  fileExportsEnabled: "PDF, PowerPoint, and HTML exports are Pro features.",
  removeBranding: "Removing KnowHow branding is a Pro feature.",
  supportEnabled: "In-app support is a Pro feature.",
};

/**
 * The blocked entitlement when a request failed a plan check, so the caller can
 * answer with an upgrade prompt instead of a bare error string.
 */
function entitlementFromError(error: unknown) {
  if (!(error instanceof KnowHowApiError)) return null;
  const kind = error.entitlement;
  if (!kind) return null;
  return { kind, message: ENTITLEMENT_COPY[kind] ?? error.message };
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

/**
 * Compact age for dense rows. Anything older than a fortnight falls back to
 * the absolute date, because "63d ago" is harder to reason about than a date.
 */
function relativeDate(value?: string) {
  if (!value) return "—";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "—";
  const elapsed = Date.now() - then;
  const day = 24 * 60 * 60 * 1000;
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < day) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  const days = Math.floor(elapsed / day);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days}d ago`;
  return formatDate(value);
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

function audienceSuccessMessage(audiences: Audience[]) {
  if (!audiences.length) return "no longer shared";
  if (audiences.some((audience) => audience.kind === "link")) {
    return "available to anyone with the link";
  }
  if (audiences.some((audience) => audience.kind === "workspace")) {
    return "visible to the entire workspace";
  }
  const groupCount = audiences.filter((audience) => audience.kind === "group").length;
  const personCount = audiences.filter((audience) => audience.kind === "user").length;
  const parts = [
    groupCount ? `${groupCount} ${groupCount === 1 ? "group" : "groups"}` : "",
    personCount ? `${personCount} ${personCount === 1 ? "person" : "people"}` : "",
  ].filter(Boolean);
  return parts.length ? `visible to ${parts.join(" and ")}` : "kept private";
}

function liveGuideUrl(origin: string, workspaceSlug: string, guide: Guide) {
  const token = guide.publishedRevision?.audiences.find(
    (audience) => audience.kind === "link",
  )?.subjectId;
  return token
    ? `${origin}/share/${encodeURIComponent(token)}`
    : `${origin}${guideHref(workspaceSlug, guide.id, "published")}`;
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

/** Paid plans that earn the workspace's own mark in the top bar. */
const BRANDED_PLANS = new Set(["pro_trial", "pro", "enterprise"]);

function planLabel(plan: string | undefined) {
  switch (plan) {
    case "pro_trial":
      return "Pro trial";
    case "pro":
      return "Pro";
    case "enterprise":
      return "Enterprise";
    default:
      return "Free";
  }
}

function workspacePlanLabel(
  subscription?: NonNullable<BootstrapResponse["activeWorkspace"]>["workspace"]["subscription"],
) {
  return planLabel(subscription?.plan);
}

const PLAN_FEATURES: Array<{
  id: string;
  key: keyof NonNullable<BootstrapResponse["activeWorkspace"]>["entitlements"];
  label: string;
  freeNote: string;
}> = [
  {
    id: "editor-privacy-tools",
    key: "privacyToolsEnabled",
    label: "Editor blur and annotations",
    freeNote: "Click targets and crop on Free",
  },
  {
    id: "extension-auto-blur",
    key: "privacyToolsEnabled",
    label: "Extension Auto Blur",
    freeNote: "Standard capture on Free",
  },
  {
    id: "desktop-capture",
    key: "desktopCaptureEnabled",
    label: "Windows desktop capture",
    freeNote: "Manual guides only on Free",
  },
  {
    id: "file-exports",
    key: "fileExportsEnabled",
    label: "PDF, PowerPoint, and HTML exports",
    freeNote: "Markdown only on Free",
  },
  {
    id: "remove-branding",
    key: "removeBranding",
    label: "Remove KnowHow branding",
    freeNote: "KnowHow branding shown on Free",
  },
  {
    id: "in-app-support",
    key: "supportEnabled",
    label: "In-app support",
    freeNote: "Contact form on Free",
  },
];

function PlanDialog({
  subscription,
  entitlements,
  metrics,
  busy,
  onClose,
  onStartTrial,
  onSelectPro,
  onRequestEnterprise,
}: {
  subscription?: NonNullable<BootstrapResponse["activeWorkspace"]>["workspace"]["subscription"];
  entitlements: NonNullable<BootstrapResponse["activeWorkspace"]>["entitlements"];
  metrics: NonNullable<BootstrapResponse["activeWorkspace"]>["metrics"];
  busy: boolean;
  onClose: () => void;
  onStartTrial: () => Promise<void>;
  onSelectPro: () => Promise<void>;
  onRequestEnterprise: () => Promise<void>;
}) {
  const plan = subscription?.plan ?? "free";
  const trialAvailable = plan === "free" && subscription?.trialConsumed !== true;
  return (
    <Modal title="Workspace plan" eyebrow="Billing" onClose={onClose}>
      <div className="modal-form">
        <p>
          You are on <strong>{plan === "pro_trial" ? "Pro trial" : plan === "pro" ? "Pro" : plan === "enterprise" ? "Enterprise" : "Free"}</strong>
          {subscription?.expiresAt && plan !== "free"
            ? ` until ${formatDate(subscription.expiresAt)}`
            : null}
          . Pro and Enterprise share the same product. Enterprise is for higher usage.
        </p>
        <p className="privacy-caption">
          Online billing is not available yet. Contact sales and we will follow up
          before making any paid plan change.
        </p>
        <section className="plan-usage-section">
          <h3 className="plan-section-heading">This workspace</h3>
          <UsageMeter
            label="Guides"
            used={metrics.guides}
            maximum={entitlements.maximumGuides}
          />
          <UsageMeter
            label="People"
            used={metrics.members}
            maximum={entitlements.maximumUsers}
          />
          <p className="privacy-caption">
            Archiving a guide frees its slot. Creators are capped at{" "}
            {entitlements.maximumCreators}.
          </p>
        </section>
        <section className="plan-feature-section">
          <h3 className="plan-section-heading">Features</h3>
          <ul className="plan-feature-list">
            {PLAN_FEATURES.map((feature) => {
              const included = Boolean(entitlements[feature.key]);
              return (
                <li key={feature.id} data-included={included}>
                  <span>{feature.label}</span>
                  {included ? (
                    <span className="plan-feature-included">Included</span>
                  ) : (
                    <span className="plan-feature-locked">
                      <span className="plan-feature-note">
                        {feature.freeNote}
                      </span>
                      <ProBadge size="sm" />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
        <footer className="modal-footer plan-dialog-footer">
          <button className="button secondary" type="button" onClick={onClose}>
            Close
          </button>
          {trialAvailable ? (
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={() => void onStartTrial()}
            >
              Start 14-day Pro trial
            </button>
          ) : null}
          {plan === "free" || plan === "pro_trial" ? (
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={() => void onSelectPro()}
            >
              Contact sales about Pro
            </button>
          ) : null}
          {plan !== "enterprise" ? (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => void onRequestEnterprise()}
            >
              Request Enterprise
            </button>
          ) : null}
        </footer>
      </div>
    </Modal>
  );
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
    title: "Invite teammates",
    description: "Send an invitation to someone who will use this workspace with you.",
  },
  extension_installation: {
    title: "Install the capture extension",
    description: "Add KnowHow to Chrome or Edge so you can record a real workflow.",
  },
  extension_pin: {
    title: "Pin the extension",
    description: "Keep KnowHow on the browser toolbar so capture is one click away.",
  },
  first_capture: {
    title: "Capture a guide",
    description: "Record one ordinary process and review the screenshots.",
  },
  first_guide: {
    title: "Write a guide",
    description: "Create the first guide so your team has something to follow.",
  },
  first_publication: {
    title: "Share a guide",
    description: "Choose who can view it and copy the live link.",
  },
};

function SetupWizard({
  onboarding,
  busy,
  canCapture,
  captureLockedByPlan,
  canManageAccess,
  chrome = "card",
  onClose,
  onConfirmReadiness,
  onNavigate,
  onOpenExtension,
  onPinExtension,
  onDismiss,
}: {
  onboarding: NonNullable<BootstrapResponse["activeWorkspace"]>["onboarding"];
  busy: boolean;
  canCapture: boolean;
  captureLockedByPlan?: boolean;
  canManageAccess: boolean;
  chrome?: "card" | "plain" | "popover";
  onClose?: () => void;
  onConfirmReadiness: () => Promise<void>;
  onNavigate: (view: View) => void;
  onOpenExtension: () => void;
  onPinExtension: () => Promise<void>;
  onDismiss: () => Promise<void>;
}) {
  const [ordinaryDataOnly, setOrdinaryDataOnly] = useState(false);
  const [policiesReviewed, setPoliciesReviewed] = useState(false);
  if (onboarding.completedAt) return null;
  const readiness = onboarding.steps.find((step) => step.id === "workspace_readiness");
  const checklist = onboarding.steps.filter((step) => step.id !== "workspace_readiness");
  const progressSteps = chrome === "popover" ? checklist : onboarding.steps;
  const completed = progressSteps.filter((step) => step.completed).length;
  const percent = progressSteps.length
    ? Math.round((completed / progressSteps.length) * 100)
    : 0;
  const current = checklist.find((step) => !step.completed);
  const readinessPending = Boolean(readiness && !readiness.completed);
  if (!current && !(readinessPending && chrome !== "popover")) return null;
  const continueBlocked =
    busy ||
    !current ||
    (current.id === "teammate_invitation" && !canManageAccess) ||
    (["extension_installation", "first_capture", "extension_pin"].includes(current.id) &&
      !canCapture &&
      !captureLockedByPlan);

  const nextAction = () => {
    if (!current) {
      onNavigate("Guides");
      return;
    }
    if (current.id === "teammate_invitation") {
      if (canManageAccess) onNavigate("Members");
      return;
    }
    if (current.id === "extension_installation" || current.id === "extension_pin") {
      if (canCapture) onOpenExtension();
      else if (captureLockedByPlan) onNavigate("Guides");
      return;
    }
    if (current.id === "first_capture") {
      if (canCapture) onOpenExtension();
      else if (captureLockedByPlan) onNavigate("Guides");
      return;
    }
    onNavigate("Guides");
  };

  const body = (
    <>
      <div className="onboarding-wizard-header">
        <div className="onboarding-checklist-copy">
          <CardTitle>Getting started</CardTitle>
          <span className="onboarding-percent">{percent}%</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label={onClose ? "Close getting started" : "Dismiss getting started"}
          disabled={busy}
          onClick={() => {
            if (onClose) onClose();
            else void onDismiss();
          }}
        >
          <X />
        </Button>
      </div>
      <DashboardProgress value={percent} label="Getting started progress" tone="accent" />
      {readinessPending && chrome !== "popover" ? (
        <div className="onboarding-readiness">
          <strong>Confirm workspace readiness</strong>
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
      ) : null}
      {current ? (
        <>
          <ul className="onboarding-task-list" aria-label="Getting started">
            {checklist.map((step) => {
              const item = ONBOARDING_STEP_COPY[step.id];
              return (
                <li key={step.id} className={step.completed ? "complete" : current.id === step.id ? "current" : ""}>
                  <button
                    type="button"
                    disabled={busy || step.completed || continueBlocked}
                    onClick={nextAction}
                  >
                    <span>{step.completed ? <Check /> : null}</span>
                    <strong>{item.title}</strong>
                  </button>
                </li>
              );
            })}
          </ul>
          {chrome !== "popover" ? (
          <div className="onboarding-wizard-actions">
            {current.id === "extension_pin" ? (
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={busy}
                onClick={() => void onPinExtension()}
              >
                <Pin /> Mark as pinned
              </Button>
            ) : null}
            <Button
              size="sm"
              type="button"
              disabled={continueBlocked}
              onClick={nextAction}
            >
              {current.id === "extension_installation" && canCapture
                ? "Install and pair"
                : current.id === "teammate_invitation"
                  ? "Invite teammates"
                  : current.id === "first_publication"
                    ? "Open guides"
                    : captureLockedByPlan &&
                        ["extension_installation", "first_capture", "extension_pin"].includes(
                          current.id,
                        )
                      ? "Write a guide instead"
                      : "Continue"}{" "}
              <ArrowRight />
            </Button>
          </div>
          ) : null}
        </>
      ) : null}
      <div className="onboarding-wizard-footer">
        <Button
          variant={onClose ? "outline" : "ghost"}
          size="sm"
          type="button"
          disabled={busy}
          onClick={() => {
            if (onClose) onClose();
            else void onDismiss();
          }}
        >
          {onClose ? "Close" : "Dismiss"}
        </Button>
      </div>
    </>
  );

  if (chrome === "plain" || chrome === "popover") {
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
  captureLockedByPlan,
  canManageAccess,
  busy,
  newGuideAction,
  newGuideCardAction,
  onOpenGuide,
  onNavigate,
  onConfirmReadiness,
  onOpenExtension,
  onPinExtension,
  onDismiss,
}: {
  data: NonNullable<BootstrapResponse["activeWorkspace"]>;
  viewerName: string;
  canCreate: boolean;
  canCapture: boolean;
  captureLockedByPlan?: boolean;
  canManageAccess: boolean;
  busy: boolean;
  newGuideAction: ReactNode;
  newGuideCardAction: ReactNode;
  onOpenGuide: (guide: Guide) => void;
  onNavigate: (view: View) => void;
  onConfirmReadiness: () => Promise<void>;
  onOpenExtension: () => void;
  onPinExtension: () => Promise<void>;
  onDismiss: () => Promise<void>;
}) {
  const { guides } = data;
  const recent = [...guides]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
  const firstName = viewerName.trim().split(/\s+/)[0] || "there";

  return (
    <div className="workspace-overview">
      <section className="home-welcome">
        <div className="home-welcome-copy">
          <div>
            <p className="eyebrow">{data.workspace.name}</p>
            <h1>Welcome back, {firstName}</h1>
            <p>Find what you need or pick up where you left off.</p>
          </div>
        </div>
        <div className="home-quick-actions">
          {canCreate ? newGuideAction : null}
          <Button
            type="button"
            variant="ghost"
            onClick={() => onNavigate("Guides")}
          >
            Browse library <ArrowRight />
          </Button>
        </div>
      </section>

      {(canManageAccess || canCapture) &&
        !data.onboarding.completedAt &&
        !data.onboarding.dismissedAt ? (
        <SetupWizard
          onboarding={data.onboarding}
          busy={busy}
          canCapture={canCapture}
          captureLockedByPlan={captureLockedByPlan}
          canManageAccess={canManageAccess}
          onConfirmReadiness={onConfirmReadiness}
          onNavigate={onNavigate}
          onOpenExtension={onOpenExtension}
          onPinExtension={onPinExtension}
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
                {canCapture
                  ? "Record a real workflow, write the first guide, or invite someone to try it with you."
                  : "Write the first guide, then share it with the people who need it."}
              </p>
            </div>
            <div className="first-run-actions">
              {canCreate ? newGuideCardAction : null}
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
          <section className="home-recents" aria-labelledby="recent-guides-title">
            <div className="home-section-heading">
              <div>
                <h2 id="recent-guides-title">Recent guides</h2>
                <p>Your latest workspace activity, all in one place.</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => onNavigate("Guides")}
              >
                See all <ArrowRight />
              </Button>
            </div>
            <div className="home-guide-grid">
              {recent.map((guide) => {
                const revision = guide.workingRevision ?? guide.publishedRevision;
                return (
                  <button
                    className="home-guide-card"
                    type="button"
                    key={guide.id}
                    onClick={() => onOpenGuide(guide)}
                  >
                    <span className="home-guide-card-topline">
                      <span className="home-guide-icon">
                        <GuideFavicon
                          workspaceId={guide.workspaceId}
                          guideId={guide.id}
                          revisionId={revision?.id}
                          mediaId={guide.faviconMediaId}
                          fallback={<BookOpen />}
                        />
                      </span>
                      <StatusBadge status={guide.status} />
                    </span>
                    <strong>{revision?.title ?? guide.title}</strong>
                    <span className="home-guide-meta">
                      Updated {formatDate(guide.updatedAt)}
                      {revision?.authorName ? ` · ${revision.authorName}` : ""}
                    </span>
                    <span className="home-guide-footer">
                      <span>Revision {revision?.number ?? "—"}</span>
                      {guide.restricted ? (
                        <LockKeyhole aria-label="Restricted" />
                      ) : (
                        <ArrowRight aria-hidden="true" />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

        </>
      )}
    </div>
  );
}

type LibraryTab = "all" | "live" | "review" | "drafts" | "archived";
type LibrarySort = "updated" | "title" | "steps" | "views";
type LibraryDensity = "cosy" | "compact";
type LibraryAudience = "any" | "workspace" | "restricted";

const LIBRARY_TABS: Array<{ key: LibraryTab; label: string }> = [
  { key: "all", label: "All" },
  { key: "live", label: "Live" },
  { key: "review", label: "In review" },
  { key: "drafts", label: "Drafts" },
  { key: "archived", label: "Archived" },
];

const LIBRARY_SORTS: Array<{ value: LibrarySort; label: string }> = [
  { value: "updated", label: "Recently updated" },
  { value: "title", label: "Title A–Z" },
  { value: "steps", label: "Step count" },
  { value: "views", label: "Most viewed" },
];

function guideMatchesTab(guide: Guide, tab: LibraryTab) {
  switch (tab) {
    case "live":
      return Boolean(guide.publishedRevision) && guide.status !== "archived";
    case "review":
      return guide.status === "review";
    case "drafts":
      return Boolean(guide.workingRevision) && guide.status !== "archived";
    case "archived":
      return guide.status === "archived";
    default:
      return guide.status !== "archived";
  }
}

/** The revision a tab is about: "Live" shows what is published, others the draft. */
function libraryRevision(guide: Guide, tab: LibraryTab) {
  return tab === "live"
    ? (guide.publishedRevision ?? guide.workingRevision)
    : (guide.workingRevision ?? guide.publishedRevision);
}

function countValues(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
}

/** Selections that still appear among the current tab's facet options. */
function visibleSelection(chosen: string[], entries: Array<[string, number]>) {
  if (!chosen.length) return chosen;
  const available = new Set(entries.map(([value]) => value));
  const kept = chosen.filter((value) => available.has(value));
  return kept.length === chosen.length ? chosen : kept;
}

function GuidesView({
  guides,
  newGuideAction,
  guideLimitNotice,
  onOpen,
  onEdit,
  onShare,
  onExport,
  onAction,
  busy,
  canCreate,
}: {
  guides: Guide[];
  newGuideAction: ReactNode;
  guideLimitNotice: ReactNode;
  onOpen: (guide: Guide) => void;
  onEdit: (guide: Guide) => void;
  onShare: (guides: Guide[]) => void;
  onExport: (guides: Guide[]) => void;
  onAction: (
    action: string,
    payload: unknown,
    message: string,
  ) => Promise<void>;
  busy: boolean;
  canCreate: boolean;
}) {
  const [tab, setTab] = useState<LibraryTab>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>("updated");
  const [sortAscending, setSortAscending] = useState(false);
  const [viewMode, setViewMode] = useState<"cards" | "list">("list");
  const [density, setDensity] = useState<LibraryDensity>("cosy");
  const [audience, setAudience] = useState<LibraryAudience>("any");
  const [categories, setCategories] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [owners, setOwners] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [deleteTargets, setDeleteTargets] = useState<Guide[]>([]);
  const { askToConfirm, dialog: confirmDialog } = useConfirmDialog();

  const scoped = guides.filter((guide) => guideMatchesTab(guide, tab));

  const categoryCounts = countValues(
    scoped.map((guide) => libraryRevision(guide, tab)?.category ?? ""),
  );
  const tagCounts = countValues(
    scoped.flatMap((guide) => libraryRevision(guide, tab)?.tags ?? []),
  );
  const ownerCounts = countValues(
    scoped.map((guide) => libraryRevision(guide, tab)?.authorName ?? ""),
  );

  // Facets are scoped to the active tab, so a category chosen under "Drafts"
  // may not exist under "Live". Keep the choice in state — switching back
  // restores it — but only apply the parts still on screen, because a filter
  // nobody can see emptying the table is impossible to recover from.
  const activeCategories = visibleSelection(categories, categoryCounts);
  const activeTags = visibleSelection(tags, tagCounts);
  const activeOwners = visibleSelection(owners, ownerCounts);
  const activeFacetCount =
    activeCategories.length +
    activeTags.length +
    activeOwners.length +
    (audience === "any" ? 0 : 1);

  const filtered = scoped
    .filter((guide) => {
      const revision = libraryRevision(guide, tab);
      if (audience === "workspace" && guide.restricted) return false;
      if (audience === "restricted" && !guide.restricted) return false;
      if (
        activeCategories.length &&
        !activeCategories.includes(revision?.category ?? "")
      ) {
        return false;
      }
      if (
        activeTags.length &&
        !activeTags.some((tag) => revision?.tags.includes(tag))
      ) {
        return false;
      }
      if (
        activeOwners.length &&
        !activeOwners.includes(revision?.authorName ?? "")
      ) {
        return false;
      }
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return [
        revision?.title ?? guide.title,
        revision?.summary ?? "",
        revision?.category ?? "",
        revision?.authorName ?? "",
        ...(revision?.tags ?? []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    })
    .sort((left, right) => {
      const direction = sortAscending ? 1 : -1;
      switch (sort) {
        case "title":
          return (
            (libraryRevision(left, tab)?.title ?? left.title).localeCompare(
              libraryRevision(right, tab)?.title ?? right.title,
            ) * direction
          );
        case "steps":
          return (
            ((libraryRevision(left, tab)?.steps.length ?? 0) -
              (libraryRevision(right, tab)?.steps.length ?? 0)) *
            direction
          );
        case "views":
          return ((left.viewCount ?? 0) - (right.viewCount ?? 0)) * direction;
        default:
          return left.updatedAt.localeCompare(right.updatedAt) * direction;
      }
    });

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visibleGuides = filtered.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );

  // Whenever the result set itself changes — not merely its order — go back to
  // the first page with nothing selected, so a bulk action can never reach a
  // row the reader has stopped looking at. Adjusting during render is React's
  // documented alternative to an effect here.
  const resultKey = [
    tab,
    query.trim().toLowerCase(),
    audience,
    activeCategories.join("\u0000"),
    activeTags.join("\u0000"),
    activeOwners.join("\u0000"),
  ].join("|");
  const [lastResultKey, setLastResultKey] = useState(resultKey);
  if (resultKey !== lastResultKey) {
    setLastResultKey(resultKey);
    setPage(0);
    setSelected([]);
  }

  const previewGuide = previewId
    ? (guides.find((guide) => guide.id === previewId) ?? null)
    : null;
  const selectedGuides = filtered.filter((guide) =>
    selected.includes(guide.id),
  );
  const archivableSelection = selectedGuides.filter(
    (guide) => guide.canArchive && guide.status !== "archived",
  );
  const shareableSelection = selectedGuides.filter(
    (guide) => guide.canShare && guide.status !== "archived",
  );
  const exportableSelection = selectedGuides.filter(
    (guide) => Boolean(guide.workingRevision ?? guide.publishedRevision),
  );
  const deletableSelection = selectedGuides.filter((guide) => guide.canDelete);
  const allOnPageSelected =
    visibleGuides.length > 0 &&
    visibleGuides.every((guide) => selected.includes(guide.id));

  const tabCounts: Record<LibraryTab, number> = {
    all: guides.filter((guide) => guideMatchesTab(guide, "all")).length,
    live: guides.filter((guide) => guideMatchesTab(guide, "live")).length,
    review: guides.filter((guide) => guideMatchesTab(guide, "review")).length,
    drafts: guides.filter((guide) => guideMatchesTab(guide, "drafts")).length,
    archived: guides.filter((guide) => guideMatchesTab(guide, "archived"))
      .length,
  };

  function toggleFacet(
    value: string,
    chosen: string[],
    setChosen: (next: string[]) => void,
  ) {
    setChosen(
      chosen.includes(value)
        ? chosen.filter((entry) => entry !== value)
        : [...chosen, value],
    );
  }

  const activeFilterChips: Array<{
    key: string;
    label: string;
    onRemove: () => void;
  }> = [
    ...(audience === "any"
      ? []
      : [
          {
            key: "audience",
            label:
              audience === "workspace"
                ? "Whole workspace"
                : "Restricted audience",
            onRemove: () => setAudience("any"),
          },
        ]),
    ...activeCategories.map((value) => ({
      key: `category:${value}`,
      label: value || "Uncategorized",
      onRemove: () => toggleFacet(value, categories, setCategories),
    })),
    ...activeTags.map((value) => ({
      key: `tag:${value}`,
      label: value,
      onRemove: () => toggleFacet(value, tags, setTags),
    })),
    ...activeOwners.map((value) => ({
      key: `owner:${value}`,
      label: value,
      onRemove: () => toggleFacet(value, owners, setOwners),
    })),
  ];

  function clearFacets() {
    setCategories([]);
    setTags([]);
    setOwners([]);
    setAudience("any");
  }

  function sortBy(key: LibrarySort) {
    setSortAscending(sort === key ? !sortAscending : key === "title");
    setSort(key);
  }

  async function approveGuide(guide: Guide) {
    const combined = guide.canPublish;
    if (
      !(await askToConfirm({
        title: combined
          ? "Approve and publish this revision?"
          : "Approve this revision?",
        description: combined
          ? "Approve this revision and make it live for its audience."
          : "Approve this revision for publication?",
        confirmLabel: combined ? "Approve and publish" : "Approve",
      }))
    )
      return;
    await onAction(
      "reviewGuide",
      { guideId: guide.id, decision: "approved" },
      combined ? "" : "Review approved",
    ).catch(() => undefined);
    if (combined) {
      await onAction(
        "publishGuide",
        { guideId: guide.id },
        "Guide shared",
      ).catch(() => undefined);
    }
  }

  async function requestChanges(guide: Guide) {
    if (
      !(await askToConfirm({
        title: "Request changes?",
        description: "Return this revision to its author for changes?",
        confirmLabel: "Request changes",
      }))
    )
      return;
    await onAction(
      "reviewGuide",
      { guideId: guide.id, decision: "changes_requested" },
      "Changes requested",
    ).catch(() => undefined);
  }

  async function restoreGuideAsDraft(guide: Guide) {
    const revision = libraryRevision(guide, "archived");
    if (!revision || !guide.canRestore) return;
    if (
      !(await askToConfirm({
        title: "Restore as a private draft?",
        description:
          "This creates a new editable draft from the archived revision. The archived version stays in history and nothing is published automatically.",
        confirmLabel: "Restore as draft",
      }))
    )
      return;
    await onAction(
      "restoreRevision",
      { guideId: guide.id, revisionId: revision.id },
      "Guide restored as a private draft",
    );
    setSelected([]);
    setPreviewId(null);
    setTab("drafts");
  }

  async function unpublishGuide(guide: Guide) {
    if (!guide.canUnpublish) return;
    if (
      !(await askToConfirm({
        title: "Return this guide to draft?",
        description:
          "The guide stops being readable by the people it was shared with and becomes an editable draft again. Publish it when you are ready to share it back.",
        confirmLabel: "Return to draft",
      }))
    )
      return;
    await onAction("unpublishGuide", { guideId: guide.id }, "Guide returned to draft");
    setSelected([]);
    setPreviewId(null);
    setTab("drafts");
  }

  function guideMenu(guide: Guide) {
    const revision = libraryRevision(guide, tab);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          className="icon-button"
          type="button"
          aria-label={`More actions for ${revision?.title ?? guide.title}`}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onClick={(event) => event.stopPropagation()}
        >
          {guide.canShare && guide.status !== "archived" ? (
            <DropdownMenuItem onClick={() => onShare([guide])}>
              <Link2 /> Share
            </DropdownMenuItem>
          ) : null}
          {guide.workingRevision ?? guide.publishedRevision ? (
            <DropdownMenuItem onClick={() => onExport([guide])}>
              <Download /> Export
            </DropdownMenuItem>
          ) : null}
          {guide.canReview && guide.status === "review" ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={busy}
                onClick={() => void approveGuide(guide)}
              >
                <CheckCircle2 />
                {guide.canPublish ? "Approve and publish" : "Approve"}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy}
                onClick={() => void requestChanges(guide)}
              >
                <RotateCcw /> Request changes
              </DropdownMenuItem>
            </>
          ) : null}
          {guide.canPublish && guide.status === "review" && !guide.canReview ? (
            <DropdownMenuItem
              disabled={busy}
              onClick={() =>
                void onAction(
                  "publishGuide",
                  { guideId: guide.id },
                  "Guide shared",
                ).catch(() => undefined)
              }
            >
              <ShieldCheck /> Publish
            </DropdownMenuItem>
          ) : null}
          {guide.canDuplicate ? (
            <DropdownMenuItem
              disabled={busy}
              onClick={() =>
                void onAction(
                  "duplicateGuide",
                  { guideId: guide.id },
                  "Guide duplicated",
                ).catch(() => undefined)
              }
            >
              <Copy /> Duplicate
            </DropdownMenuItem>
          ) : null}
          {guide.canUnpublish ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={busy}
                onClick={() => void unpublishGuide(guide)}
              >
                <Undo2 /> Return to draft
              </DropdownMenuItem>
            </>
          ) : null}
          {guide.canArchive && guide.status !== "archived" ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={busy}
                onClick={() =>
                  void onAction(
                    "archiveGuide",
                    { guideId: guide.id },
                    "Guide archived",
                  )
                }
              >
                <Archive /> Archive
              </DropdownMenuItem>
            </>
          ) : null}
          {guide.canRestore && guide.status === "archived" ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={busy}
                onClick={() => void restoreGuideAsDraft(guide)}
              >
                <RotateCcw /> Restore as draft
              </DropdownMenuItem>
            </>
          ) : null}
          {guide.canDelete ? (
            <DropdownMenuItem
              className="danger-menu-item"
              disabled={busy}
              onClick={() => setDeleteTargets([guide])}
            >
              <Trash2 /> Delete
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Knowledge library</p>
          <h1>Guides</h1>
          <p>
            Draft privately, then share with the people who need the current
            procedure. Review stays available when your workspace requires it.
          </p>
        </div>
      </div>

      {guideLimitNotice}

      <section className="card table-card library-card">
        <div className="library-view-bar">
          <div
            className="library-tabs"
            role="tablist"
            aria-label="Guide collections"
          >
            {LIBRARY_TABS.map((entry) => (
              <button
                type="button"
                role="tab"
                key={entry.key}
                aria-selected={tab === entry.key}
                className={cn(tab === entry.key && "is-active")}
                onClick={() => setTab(entry.key)}
              >
                {entry.label} <span>{tabCounts[entry.key]}</span>
              </button>
            ))}
          </div>
          <div className="library-view-controls">
            <div className="library-layout-toggle" aria-label="Row density">
              <button
                type="button"
                className={cn(density === "cosy" && "is-active")}
                aria-label="Comfortable rows"
                aria-pressed={density === "cosy"}
                onClick={() => setDensity("cosy")}
              >
                <Rows2 />
              </button>
              <button
                type="button"
                className={cn(density === "compact" && "is-active")}
                aria-label="Compact rows"
                aria-pressed={density === "compact"}
                onClick={() => setDensity("compact")}
              >
                <Rows3 />
              </button>
            </div>
            <div className="library-layout-toggle" aria-label="Guide layout">
              <button
                type="button"
                className={cn(viewMode === "list" && "is-active")}
                aria-label="Table view"
                aria-pressed={viewMode === "list"}
                onClick={() => setViewMode("list")}
              >
                <List />
              </button>
              <button
                type="button"
                className={cn(viewMode === "cards" && "is-active")}
                aria-label="Card view"
                aria-pressed={viewMode === "cards"}
                onClick={() => setViewMode("cards")}
              >
                <Grid2X2 />
              </button>
            </div>
          </div>
        </div>

        {guides.length ? (
          <div className="filter-bar">
            <label className="search-field">
              <Search />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search titles, summaries, tags, and owners"
              />
            </label>
            <Popover>
              <PopoverTrigger
                className="library-filter-trigger"
                type="button"
                aria-label={
                  activeFacetCount
                    ? `Filters, ${activeFacetCount} applied`
                    : "Filters"
                }
              >
                <SlidersHorizontal /> Filters
                {activeFacetCount ? (
                  <span className="library-filter-count">
                    {activeFacetCount}
                  </span>
                ) : null}
              </PopoverTrigger>
              <PopoverContent align="start" className="library-filter-popover">
                <div className="facet-group">
                  <p className="facet-title">Audience</p>
                  <div className="facet-list">
                    {(
                      [
                        { value: "any", label: "Everyone with access" },
                        { value: "workspace", label: "Whole workspace" },
                        { value: "restricted", label: "Restricted audience" },
                      ] as const
                    ).map((option) => (
                      <button
                        className="facet-row"
                        type="button"
                        key={option.value}
                        data-selected={audience === option.value}
                        aria-pressed={audience === option.value}
                        onClick={() => setAudience(option.value)}
                      >
                        <span className="facet-box">
                          <Check />
                        </span>
                        <span className="facet-name">{option.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <FacetGroup
                  title="Category"
                  entries={categoryCounts}
                  chosen={categories}
                  emptyLabel="Uncategorized"
                  onToggle={(value) =>
                    toggleFacet(value, categories, setCategories)
                  }
                />
                <FacetGroup
                  title="Tag"
                  entries={tagCounts}
                  chosen={tags}
                  onToggle={(value) => toggleFacet(value, tags, setTags)}
                />
                <FacetGroup
                  title="Owner"
                  entries={ownerCounts}
                  chosen={owners}
                  onToggle={(value) => toggleFacet(value, owners, setOwners)}
                />
              </PopoverContent>
            </Popover>
            <SelectMenu
              className="filter-select"
              value={sort}
              onChange={(value) => setSort(value as LibrarySort)}
              ariaLabel="Sort guides"
              options={LIBRARY_SORTS}
            />
            <span className="result-count">
              {filtered.length} {filtered.length === 1 ? "guide" : "guides"}
            </span>
          </div>
        ) : null}

        {/*
          The facets live behind a button now, so what is currently applied has
          to stay visible out here — otherwise a filter narrowing the table is
          invisible until someone reopens the menu.
        */}
        {activeFilterChips.length ? (
          <div className="library-active-filters">
            {activeFilterChips.map((chip) => (
              <button
                className="library-chip"
                type="button"
                key={chip.key}
                aria-label={`Remove filter ${chip.label}`}
                onClick={chip.onRemove}
              >
                {chip.label} <X />
              </button>
            ))}
            <button
              className="button ghost small"
              type="button"
              onClick={clearFacets}
            >
              <FilterX /> Clear all
            </button>
          </div>
        ) : null}

        {visibleGuides.length === 0 ? (
          <EmptyState
            icon={query.trim() || activeFacetCount ? Search : BookOpen}
            title={
              query.trim() || activeFacetCount
                ? "No matching guides"
                : tab === "archived"
                  ? "Nothing archived"
                  : "No guides here yet"
            }
            description={
              query.trim() || activeFacetCount
                ? "Loosen a filter or clear the search to see the rest of the library."
                : "Create a guide or capture a workflow to start a draft."
            }
            action={
              query.trim() || activeFacetCount ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setQuery("");
                    clearFacets();
                  }}
                >
                  <FilterX /> Reset filters
                </Button>
              ) : canCreate ? (
                newGuideAction
              ) : undefined
            }
          />
        ) : viewMode === "cards" ? (
          <div className="library-gallery">
            {visibleGuides.map((guide) => {
              const revision = libraryRevision(guide, tab);
              return (
                <article
                  className="library-gallery-card"
                  key={guide.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Preview ${revision?.title ?? guide.title}`}
                  onClick={(event) => {
                    if (
                      (event.target as HTMLElement).closest(
                        "button, a, [role='menuitem']",
                      )
                    )
                      return;
                    setPreviewId(guide.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setPreviewId(guide.id);
                    }
                  }}
                >
                  <div className="library-gallery-top">
                    <StatusBadge status={guide.status} />
                    {guide.restricted ? (
                      <span className="restricted-label">
                        <LockKeyhole /> Restricted
                      </span>
                    ) : (
                      <span className="workspace-label">
                        <Globe2 /> Workspace
                      </span>
                    )}
                  </div>
                  <strong className="library-gallery-title">
                    {revision?.title ?? guide.title}
                  </strong>
                  <p className="library-gallery-summary">
                    {revision?.summary || "No description yet."}
                  </p>
                  <div className="library-gallery-foot">
                    <span>{revision?.authorName ?? "Unassigned"}</span>
                    <span>
                      {revision?.steps.length ?? 0}{" "}
                      {(revision?.steps.length ?? 0) === 1 ? "step" : "steps"}{" "}
                      · {relativeDate(guide.updatedAt)}
                    </span>
                  </div>
                  <div className="library-gallery-actions">
                    {guideMenu(guide)}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="library-table-scroll">
            <table className="library-table" data-density={density}>
              <thead>
                <tr>
                  <th className="library-cell-pick">
                    <Checkbox
                      checked={allOnPageSelected}
                      aria-label="Select every guide on this page"
                      onCheckedChange={(checked) =>
                        setSelected((current) => {
                          const ids = visibleGuides.map((guide) => guide.id);
                          return checked
                            ? [...new Set([...current, ...ids])]
                            : current.filter((id) => !ids.includes(id));
                        })
                      }
                    />
                  </th>
                  <LibraryHeader
                    label="Guide"
                    sortKey="title"
                    sort={sort}
                    ascending={sortAscending}
                    onSort={sortBy}
                  />
                  <th>Status</th>
                  <th>Audience</th>
                  <LibraryHeader
                    label="Steps"
                    sortKey="steps"
                    sort={sort}
                    ascending={sortAscending}
                    onSort={sortBy}
                  />
                  <LibraryHeader
                    label="Views"
                    sortKey="views"
                    sort={sort}
                    ascending={sortAscending}
                    onSort={sortBy}
                  />
                  <th>Owner</th>
                  <LibraryHeader
                    label="Updated"
                    sortKey="updated"
                    sort={sort}
                    ascending={sortAscending}
                    onSort={sortBy}
                  />
                  <th className="library-cell-actions">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleGuides.map((guide) => {
                  const revision = libraryRevision(guide, tab);
                  const isSelected = selected.includes(guide.id);
                  return (
                    <tr
                      key={guide.id}
                      data-selected={isSelected || undefined}
                      onClick={() => setPreviewId(guide.id)}
                    >
                      <td
                        className="library-cell-pick"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Checkbox
                          checked={isSelected}
                          aria-label={`Select ${revision?.title ?? guide.title}`}
                          onCheckedChange={() =>
                            setSelected((current) =>
                              current.includes(guide.id)
                                ? current.filter((id) => id !== guide.id)
                                : [...current, guide.id],
                            )
                          }
                        />
                      </td>
                      <td>
                        <div className="library-title-cell">
                          <span className="guide-icon">
                            <GuideFavicon
                              workspaceId={guide.workspaceId}
                              guideId={guide.id}
                              revisionId={revision?.id}
                              mediaId={guide.faviconMediaId}
                              fallback={
                                guide.restricted ? <LockKeyhole /> : <BookOpen />
                              }
                            />
                          </span>
                          <span className="library-title-copy">
                            <strong>{revision?.title ?? guide.title}</strong>
                            <small>
                              {revision?.summary || "No description yet."}
                            </small>
                          </span>
                        </div>
                      </td>
                      <td>
                        <StatusBadge status={guide.status} />
                      </td>
                      <td>
                        {guide.restricted ? (
                          <span className="restricted-label">
                            <LockKeyhole /> Restricted
                          </span>
                        ) : (
                          <span className="workspace-label">
                            <Globe2 /> Workspace
                          </span>
                        )}
                      </td>
                      <td className="library-cell-number">
                        {revision?.steps.length ?? 0}
                      </td>
                      <td className="library-cell-number">
                        {guide.publishedRevision ? (guide.viewCount ?? 0) : "—"}
                      </td>
                      <td className="library-cell-muted">
                        {revision?.authorName ?? "—"}
                      </td>
                      <td className="library-cell-muted">
                        {relativeDate(guide.updatedAt)}
                      </td>
                      <td
                        className="library-cell-actions"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="library-row-actions">
                          <button
                            className="icon-button"
                            type="button"
                            aria-label={`Open ${revision?.title ?? guide.title}`}
                            onClick={() => onOpen(guide)}
                          >
                            <Eye />
                          </button>
                          {guide.canEdit && guide.status !== "archived" ? (
                            <button
                              className="icon-button"
                              type="button"
                              aria-label={`Edit ${revision?.title ?? guide.title}`}
                              onClick={() => onEdit(guide)}
                            >
                              <PenLine />
                            </button>
                          ) : null}
                          {guideMenu(guide)}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {filtered.length > pageSize ? (
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

      {selectedGuides.length ? (
        <div className="library-bulk-bar" role="status">
          <span className="library-bulk-count">
            {selectedGuides.length} selected
          </span>
          <span className="library-bulk-divider" />
          {shareableSelection.length ? (
            <button
              className="library-bulk-action"
              type="button"
              onClick={() => onShare(shareableSelection)}
            >
              <Link2 /> Share
            </button>
          ) : null}
          {exportableSelection.length ? (
            <button
              className="library-bulk-action"
              type="button"
              onClick={() => onExport(exportableSelection)}
            >
              <Download /> Export
            </button>
          ) : null}
          {deletableSelection.length ? (
            <button
              className="library-bulk-action"
              type="button"
              disabled={busy}
              onClick={() => setDeleteTargets(deletableSelection)}
            >
              <Trash2 /> Delete
            </button>
          ) : null}
          {archivableSelection.length ? (
            <button
              className="library-bulk-action"
              type="button"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  if (
                    !(await askToConfirm({
                      title:
                        archivableSelection.length === 1
                          ? "Archive this guide?"
                          : `Archive ${archivableSelection.length} guides?`,
                      description:
                        "Archived guides stop being shared and move out of the working library. Published revisions stay readable in their history.",
                      confirmLabel: "Archive",
                      tone: "danger",
                    }))
                  )
                    return;
                  for (const guide of archivableSelection) {
                    await onAction(
                      "archiveGuide",
                      { guideId: guide.id },
                      "",
                    );
                  }
                  toast.success(
                    archivableSelection.length === 1
                      ? "Guide archived"
                      : `${archivableSelection.length} guides archived`,
                  );
                  setSelected([]);
                })();
              }}
            >
              <Archive /> Archive
            </button>
          ) : null}
          <span className="library-bulk-divider" />
          <button
            className="library-bulk-action"
            type="button"
            onClick={() => setSelected([])}
          >
            <X /> Clear
          </button>
        </div>
      ) : null}

      <Sheet
        open={Boolean(previewGuide)}
        onOpenChange={(open) => {
          if (!open) setPreviewId(null);
        }}
      >
        {previewGuide ? (
          <SheetContent className="library-preview" side="right">
            <LibraryPreview
              guide={previewGuide}
              revision={libraryRevision(previewGuide, tab)}
              busy={busy}
              onOpen={() => onOpen(previewGuide)}
              onEdit={() => onEdit(previewGuide)}
              onShare={() => onShare([previewGuide])}
              onExport={() => onExport([previewGuide])}
              onApprove={() => void approveGuide(previewGuide)}
              onRequestChanges={() => void requestChanges(previewGuide)}
              onPublish={() =>
                void onAction(
                  "publishGuide",
                  { guideId: previewGuide.id },
                  "Guide shared",
                ).catch(() => undefined)
              }
              onRestore={() => void restoreGuideAsDraft(previewGuide)}
            />
          </SheetContent>
        ) : null}
      </Sheet>

      {deleteTargets.length ? (
        <GuideDeleteDialog
          busy={busy}
          count={deleteTargets.length}
          onCancel={() => setDeleteTargets([])}
          onConfirm={async () => {
            for (const guide of deleteTargets) {
              await onAction(
                "deleteGuide",
                { guideId: guide.id },
                "",
              );
            }
            toast.success(
              deleteTargets.length === 1
                ? "Guide deleted"
                : `${deleteTargets.length} guides deleted`,
            );
            setDeleteTargets([]);
            setSelected([]);
          }}
        />
      ) : null}
      {confirmDialog}
    </div>
  );
}

function LibraryHeader({
  label,
  sortKey,
  sort,
  ascending,
  onSort,
}: {
  label: string;
  sortKey: LibrarySort;
  sort: LibrarySort;
  ascending: boolean;
  onSort: (key: LibrarySort) => void;
}) {
  const active = sort === sortKey;
  return (
    <th
      aria-sort={active ? (ascending ? "ascending" : "descending") : "none"}
      data-active={active || undefined}
    >
      <button type="button" onClick={() => onSort(sortKey)}>
        {label}
        {active ? ascending ? <ArrowUp /> : <ArrowDown /> : null}
      </button>
    </th>
  );
}

function FacetGroup({
  title,
  entries,
  chosen,
  onToggle,
  emptyLabel = "Untagged",
}: {
  title: string;
  entries: Array<[string, number]>;
  chosen: string[];
  onToggle: (value: string) => void;
  emptyLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!entries.length) return null;
  const shown = expanded ? entries : entries.slice(0, 6);

  return (
    <div className="facet-group">
      <p className="facet-title">{title}</p>
      <div className="facet-list">
        {shown.map(([value, count]) => (
          <button
            className="facet-row"
            type="button"
            key={value}
            data-selected={chosen.includes(value)}
            aria-pressed={chosen.includes(value)}
            onClick={() => onToggle(value)}
          >
            <span className="facet-box">
              <Check />
            </span>
            <span className="facet-name">{value || emptyLabel}</span>
            <span className="facet-count">{count}</span>
          </button>
        ))}
        {entries.length > 6 ? (
          <button
            className="facet-more"
            type="button"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show fewer" : `Show ${entries.length - 6} more`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function LibraryPreview({
  guide,
  revision,
  busy,
  onOpen,
  onEdit,
  onShare,
  onExport,
  onApprove,
  onRequestChanges,
  onPublish,
  onRestore,
}: {
  guide: Guide;
  revision: GuideRevisionView | null;
  busy: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onShare: () => void;
  onExport: () => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  onPublish: () => void;
  onRestore: () => void;
}) {
  const live = guide.publishedRevision;
  const steps = revision?.steps ?? [];

  return (
    <>
      <div className="library-preview-head">
        <div className="library-preview-chips">
          <StatusBadge status={guide.status} />
          {guide.restricted ? (
            <span className="restricted-label">
              <LockKeyhole /> Restricted
            </span>
          ) : (
            <span className="workspace-label">
              <Globe2 /> Workspace
            </span>
          )}
          {revision && isCapturedGuideSource(revision.source) ? (
            <span className="workspace-label">
              <Sparkles /> Captured
            </span>
          ) : null}
        </div>
        <SheetTitle className="library-preview-title">
          {revision?.title ?? guide.title}
        </SheetTitle>
        <SheetDescription className="library-preview-summary">
          {revision?.summary || "No description yet."}
        </SheetDescription>
      </div>

      <div className="library-preview-body">
        <dl className="library-preview-facts">
          <div>
            <dt>Owner</dt>
            <dd>{revision?.authorName ?? "—"}</dd>
          </div>
          <div>
            <dt>Category</dt>
            <dd>{revision?.category || "Uncategorized"}</dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd>
              {revision ? `Revision ${revision.number}` : "—"}
              {live && guide.workingRevision && live.number !== revision?.number
                ? ` · v${live.number} remains live`
                : ""}
            </dd>
          </div>
          <div>
            <dt>Last updated</dt>
            <dd>{formatDate(guide.updatedAt)}</dd>
          </div>
          <div>
            <dt>Views</dt>
            <dd>{live ? (guide.viewCount ?? 0) : "Not shared"}</dd>
          </div>
          <div>
            <dt>Steps</dt>
            <dd>{steps.length}</dd>
          </div>
        </dl>

        {revision?.tags.length ? (
          <div>
            <p className="library-preview-label">Tags</p>
            <div className="library-preview-tags">
              {revision.tags.map((tag) => (
                <span className="library-tag" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <p className="library-preview-label">
            Procedure
            {steps.length ? ` · first ${Math.min(6, steps.length)} steps` : ""}
          </p>
          {steps.length ? (
            <ol className="library-preview-steps">
              {steps.slice(0, 6).map((step) => (
                <li key={step.id} data-kind={step.kind}>
                  <span>{step.title.trim() || step.description.trim() || "Untitled step"}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="library-preview-empty">
              This revision has no steps yet.
            </p>
          )}
          {steps.length > 6 ? (
            <button className="button ghost small" type="button" onClick={onOpen}>
              Read all {steps.length} steps <ArrowRight />
            </button>
          ) : null}
        </div>

        {guide.revisionHistory?.length ? (
          <div>
            <p className="library-preview-label">History</p>
            <ul className="library-preview-history">
              {guide.revisionHistory.slice(0, 5).map((entry) => (
                <li key={entry.id}>
                  <strong>Revision {entry.number}</strong>
                  <span>
                    {titleCase(entry.status)} · {entry.authorName} ·{" "}
                    {formatDate(entry.publishedAt ?? entry.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="library-preview-foot">
        <Button type="button" onClick={onOpen}>
          <Eye /> Open guide
        </Button>
        {guide.canEdit && guide.status !== "archived" ? (
          <Button variant="outline" type="button" onClick={onEdit}>
            <PenLine /> Edit
          </Button>
        ) : null}
        {guide.canShare && guide.status !== "archived" ? (
          <Button variant="outline" type="button" onClick={onShare}>
            <Link2 /> Share
          </Button>
        ) : null}
        {guide.publishedRevision ? (
          <Button variant="outline" type="button" onClick={onExport}>
            <Download /> Export
          </Button>
        ) : null}
        {guide.canReview && guide.status === "review" ? (
          <>
            <Button
              variant="secondary"
              type="button"
              disabled={busy}
              onClick={onApprove}
            >
              {guide.canPublish ? "Approve and publish" : "Approve"}
            </Button>
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={onRequestChanges}
            >
              Request changes
            </Button>
          </>
        ) : null}
        {guide.canPublish && guide.status === "review" && !guide.canReview ? (
          <Button type="button" disabled={busy} onClick={onPublish}>
            Publish
          </Button>
        ) : null}
        {guide.canRestore && guide.status === "archived" ? (
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={onRestore}
          >
            <RotateCcw /> Restore as draft
          </Button>
        ) : null}
      </div>
    </>
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
  onShare,
  onReact,
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
  onExport: (format: GuideExportFormatChoice) => void;
  onRestore: (revisionId: string) => void;
  onPublishedViewed: () => void;
  onComplete: () => void;
  onShare?: () => void;
  onReact?: (reaction: "like" | "dislike" | "clear") => void;
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
    <>
      <GuideReaderView
        guide={guide}
        revision={revision}
        revisionMode={revisionMode}
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        logoKey={logoKey}
        accentColor={accentColor}
        clickTargetColor={clickTargetColor}
        liveUrl={liveUrl}
        canExport={canExport}
        canRestore={canRestore}
        busy={busy}
        onClose={onClose}
        onEdit={onEdit}
        onDelete={onDelete ? () => setDeletePromptOpen(true) : undefined}
        onRevisionChange={onRevisionChange}
        onExport={onExport}
        onRestore={onRestore}
        onPublishedViewed={onPublishedViewed}
        onComplete={onComplete}
        onShare={onShare}
        onReact={onReact}
      />
      {deletePromptOpen && onDelete ? (
        <GuideDeleteDialog
          busy={busy}
          onCancel={() => setDeletePromptOpen(false)}
          onConfirm={onDelete}
        />
      ) : null}
    </>
  );
}

function DesktopCaptureDialog({
  desktopDevices,
  typedTextPolicy,
  busy,
  onClose,
  onRevokeDesktopDevice,
}: {
  desktopDevices: DesktopCaptureDevice[];
  typedTextPolicy: WorkspaceSettings["desktopTypedTextPolicy"];
  busy: boolean;
  onClose: () => void;
  onRevokeDesktopDevice: (deviceRecordId: string) => Promise<void>;
}) {
  const desktopDownloads = [
    {
      label: "EXE · x64",
      href: process.env.NEXT_PUBLIC_KNOWHOW_DESKTOP_EXE_X64_URL,
    },
    {
      label: "MSI · x64",
      href: process.env.NEXT_PUBLIC_KNOWHOW_DESKTOP_MSI_X64_URL,
    },
    {
      label: "EXE · ARM64",
      href: process.env.NEXT_PUBLIC_KNOWHOW_DESKTOP_EXE_ARM64_URL,
    },
    {
      label: "MSI · ARM64",
      href: process.env.NEXT_PUBLIC_KNOWHOW_DESKTOP_MSI_ARM64_URL,
    },
  ].filter(
    (download): download is { label: string; href: string } =>
      Boolean(download.href),
  );

  return (
    <Modal
      title="Desktop capture"
      eyebrow="Windows 10 & 11"
      onClose={onClose}
      wide
    >
      <div className="modal-form desktop-capture-dialog">
        <section className="desktop-capture-intro">
          <span className="desktop-capture-intro-icon">
            <Laptop />
          </span>
          <div>
            <strong>Record work across desktop applications</strong>
            <p>
              Choose an app, window, monitor, or all displays in KnowHow Capture.
              Your finished recording opens as a private draft in the web editor.
            </p>
          </div>
        </section>

        <section className="desktop-capture-dialog-section">
          <div className="desktop-capture-dialog-heading">
            <div>
              <p className="eyebrow">Get the app</p>
              <h3>Install KnowHow Capture</h3>
            </div>
            <Badge variant="outline">Windows</Badge>
          </div>
          {desktopDownloads.length ? (
            <div className="desktop-downloads">
              {desktopDownloads.map((download) => (
                <a
                  className="button secondary small"
                  href={download.href}
                  key={download.label}
                >
                  <Download /> {download.label}
                </a>
              ))}
            </div>
          ) : (
            <p className="desktop-capture-dialog-empty">
              Signed installers are not available on this release channel yet.
            </p>
          )}
        </section>

        <section className="desktop-capture-dialog-section">
          <div className="desktop-capture-dialog-heading">
            <div>
              <p className="eyebrow">Paired devices</p>
              <h3>
                {desktopDevices.length
                  ? countPhrase(desktopDevices.length, "connected device")
                  : "No connected devices"}
              </h3>
              <p>
                Exact non-password text is{" "}
                {typedTextPolicy === "allowed"
                  ? "allowed when the author enables it"
                  : "disabled by workspace policy"}
                .
              </p>
            </div>
          </div>
          {desktopDevices.length ? (
            <div className="desktop-device-list">
              {desktopDevices.map((device) => (
                <div className="desktop-device-row" key={device.id}>
                  <span className="desktop-device-row-icon">
                    <Laptop />
                  </span>
                  <div>
                    <strong>{device.name}</strong>
                    <small>
                      {device.version} · {device.architecture.toUpperCase()} · Last
                      used{" "}
                      {device.lastUsedAt
                        ? formatDate(device.lastUsedAt, true)
                        : "never"}
                    </small>
                  </div>
                  <Badge variant="outline">Connected</Badge>
                  <button
                    className="button ghost small"
                    type="button"
                    disabled={busy}
                    onClick={() => void onRevokeDesktopDevice(device.id)}
                  >
                    <Trash2 /> Revoke
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="desktop-capture-dialog-empty">
              Install the app, choose Connect workspace, and approve the named
              device request in your browser.
            </p>
          )}
        </section>

        <p className="privacy-caption desktop-capture-dialog-privacy">
          <ShieldCheck /> Passwords, clipboard contents, raw keys, and secure
          Windows surfaces are always excluded. Password fields are masked
          before upload; review each draft before you share it.
        </p>

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
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "standard" | "restricted">("all");
  const visibleGroups = groups.filter((group) => {
    const matchesQuery = `${group.name} ${group.description}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
    const matchesScope =
      scope === "all" ||
      (scope === "restricted" ? group.sensitive : !group.sensitive);
    return matchesQuery && matchesScope;
  });
  const restrictedCount = groups.filter((group) => group.sensitive).length;
  const membershipCount = groups.reduce((total, group) => total + group.memberCount, 0);
  const publishedGuideCount = groups.reduce(
    (total, group) => total + (group.publishedGuideCount ?? 0),
    0,
  );
  return (
    <div className="view-stack audience-directory-page">
      <div className="page-heading directory-page-heading">
        <div>
          <p className="eyebrow">Content audiences</p>
          <h1>Groups</h1>
          <p>
            Organize who receives published guides without changing what they can do.
          </p>
        </div>
      </div>
      <section className="directory-summary-grid" aria-label="Group summary">
        <article><span><Group /></span><div><strong>{groups.length}</strong><small>Total groups</small></div></article>
        <article><span><Users /></span><div><strong>{membershipCount}</strong><small>Membership assignments</small></div></article>
        <article><span><LockKeyhole /></span><div><strong>{restrictedCount}</strong><small>Restricted groups</small></div></article>
        <article><span><BookOpen /></span><div><strong>{publishedGuideCount}</strong><small>Published guide links</small></div></article>
      </section>
      <section className="card group-directory-card directory-panel">
        <header className="directory-panel-header">
          <div>
            <p className="eyebrow">Audience directory</p>
            <h2>{countPhrase(groups.length, "workspace group")}</h2>
          </div>
          {groups.length ? <span className="result-count">{countPhrase(visibleGroups.length, "result")}</span> : null}
        </header>
        {groups.length ? (
          <div className="filter-bar group-filter-bar">
            <label className="search-field">
              <Search />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search groups" aria-label="Search audience groups" />
            </label>
            <div className="directory-filter-tabs" role="group" aria-label="Filter groups by access type">
              {([
                ["all", "All"],
                ["standard", "Standard"],
                ["restricted", "Restricted"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={scope === value ? "active" : ""}
                  aria-pressed={scope === value}
                  onClick={() => setScope(value)}
                >
                  {label}
                  <span>
                    {value === "all"
                      ? groups.length
                      : value === "restricted"
                        ? restrictedCount
                        : groups.length - restrictedCount}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {groups.length ? (
          visibleGroups.length ? (
            <div className="group-grid audience-group-grid">
              {visibleGroups.map((group) => (
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
                  <span className="group-card-title">
                    <strong>{group.name}</strong>
                    {group.kind === "all_members" ? <Badge variant="outline">Built in</Badge> : null}
                  </span>
                  <small>
                    {group.kind === "all_members"
                      ? "Built-in audience for every active workspace member."
                      : group.description || "No description added yet."}
                  </small>
                  <span className="group-card-stats">
                    <span><Users /> <strong>{group.memberCount}</strong> members</span>
                    <span><BookOpen /> <strong>{group.publishedGuideCount ?? 0}</strong> guides</span>
                  </span>
                  {group.sensitive ? <span className="restricted-label"><LockKeyhole /> Restricted membership</span> : null}
                </span>
                <span className="group-card-action">
                  {group.kind === "all_members" ? <ShieldCheck /> : <ArrowRight />}
                </span>
              </button>
              ))}
            </div>
          ) : (
            <div className="directory-no-results">
              <Search />
              <strong>No groups found</strong>
              <span>Try a different search or audience filter.</span>
              <button type="button" className="button ghost small" onClick={() => { setQuery(""); setScope("all"); }}>Clear filters</button>
            </div>
          )
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
  const [memberQuery, setMemberQuery] = useState("");
  const { askToConfirm, dialog: confirmDialog } = useConfirmDialog();
  const activeMembers = members.filter((member) =>
    member.status === "active" &&
    `${member.name ?? ""} ${member.email}`.toLowerCase().includes(memberQuery.trim().toLowerCase()),
  );
  return (
    <Modal
      title={group ? `Edit ${group.name}` : "Create audience group"}
      eyebrow="Workspace sharing"
      onClose={onClose}
      wide
    >
      <form
        className="modal-form group-editor-form"
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
        <section className="group-details-panel">
          <div className="form-section-heading">
            <span className="form-section-icon"><Group /></span>
            <div><strong>Group details</strong><small>Name the audience and describe who it is for.</small></div>
          </div>
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
        <label className={`choice-row emphasized group-restriction-option${sensitive ? " selected" : ""}`}>
          <input
            type="checkbox"
            checked={sensitive}
            onChange={(event) => setSensitive(event.target.checked)}
          />
          <span>
            <strong>Restricted membership</strong>
            <small>
              Membership can only be assigned by an administrator, never by a
              generic invite.
            </small>
          </span>
        </label>
        </section>
        <div className="member-picker">
          <div className="member-picker-heading form-section-heading">
            <span className="form-section-icon"><Users /></span>
            <div><span className="field-label">Members</span><small>{countPhrase(memberIds.length, "person")} selected</small></div>
            <label className="search-field compact"><Search /><input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="Search members" aria-label="Search members to add" /></label>
          </div>
          <small className="field-help">Membership controls guide delivery, not workspace roles.</small>
          <div className="group-member-options">
          {activeMembers.map((member) => (
              <label className={`choice-row group-member-option${memberIds.includes(member.userId) ? " selected" : ""}`} key={member.id}>
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
          {!activeMembers.length ? <div className="group-member-empty"><Search /><span>No active members found.</span></div> : null}
          </div>
        </div>
        {group && (group.publishedGuideCount ?? 0) > 0 ? (
          <PolicyNote icon={LockKeyhole}>
            This group is used by {countPhrase(group.publishedGuideCount ?? 0, "published guide")}. Remove that audience before deleting the group.
          </PolicyNote>
        ) : null}
        <footer className="modal-footer">
          {group ? (
            <button
              className="button danger-button"
              type="button"
              disabled={busy || (group.publishedGuideCount ?? 0) > 0}
              onClick={() => {
                void askToConfirm({
                  title: `Delete ${group.name}?`,
                  description: (group.publishedGuideCount ?? 0) > 0
                    ? `${group.name} is used by ${countPhrase(group.publishedGuideCount ?? 0, "published guide")}. Remove that audience before deleting the group.`
                    : `${countPhrase(group.memberCount, "member")} will lose this audience assignment. This does not suspend anyone.`,
                  confirmLabel: "Delete group",
                  tone: "danger",
                }).then((confirmed) => {
                  if (confirmed) void onDelete(group.id);
                });
              }}
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
      {confirmDialog}
    </Modal>
  );
}

function MembersView({
  members,
  invitations,
  supportRequests,
  supportGrants,
  busy,
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
  const [memberFilter, setMemberFilter] = useState<"all" | "active" | "admins" | "suspended">("all");
  const visibleMembers = useMemo(() => {
    const query = memberQuery.trim().toLocaleLowerCase();
    return members.filter((member) => {
      const matchesQuery = !query ||
        `${member.name ?? ""} ${member.email} ${member.roles.join(" ")}`
          .toLocaleLowerCase()
          .includes(query);
      const matchesFilter =
        memberFilter === "all" ||
        (memberFilter === "active" && member.status === "active") ||
        (memberFilter === "suspended" && member.status === "suspended") ||
        (memberFilter === "admins" && member.roles.includes("administrator"));
      return matchesQuery && matchesFilter;
    });
  }, [memberFilter, memberQuery, members]);
  const activeMemberCount = members.filter((member) => member.status === "active").length;
  const adminCount = members.filter((member) => member.roles.includes("administrator")).length;
  const suspendedCount = members.filter((member) => member.status === "suspended").length;
  const activeInvitationCount = invitations.filter((invite) =>
    !invite.revokedAt &&
    invite.useCount < invite.maxUses &&
    Date.parse(invite.expiresAt) > renderedAt,
  ).length;
  return (
    <div className="view-stack access-directory-page">
      <div className="page-heading directory-page-heading">
        <div>
          <p className="eyebrow">Workspace access</p>
          <h1>Members & invitations</h1>
          <p>
            Manage workspace roles, audience membership, and secure invitations.
          </p>
        </div>
      </div>
      <section className="directory-summary-grid members-summary-grid" aria-label="Member summary">
        <article><span><Users /></span><div><strong>{members.length}</strong><small>Total members</small></div></article>
        <article><span><UserCheck /></span><div><strong>{activeMemberCount}</strong><small>Active members</small></div></article>
        <article><span><ShieldCheck /></span><div><strong>{adminCount}</strong><small>Administrators</small></div></article>
        <article><span><Mail /></span><div><strong>{activeInvitationCount}</strong><small>Pending invitations</small></div></article>
      </section>
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
      <section className="card table-card members-directory directory-panel">
        <div className="section-heading compact directory-panel-header">
          <div>
            <p className="eyebrow">People directory</p>
            <h2>
              {countPhrase(members.length, "workspace member")}
            </h2>
          </div>
        </div>
        <div className="member-directory-toolbar">
          <div className="directory-filter-tabs" role="group" aria-label="Filter members">
            {([
              ["all", "All", members.length],
              ["active", "Active", activeMemberCount],
              ["admins", "Admins", adminCount],
              ["suspended", "Suspended", suspendedCount],
            ] as const).map(([value, label, count]) => (
              <button key={value} type="button" className={memberFilter === value ? "active" : ""} aria-pressed={memberFilter === value} onClick={() => setMemberFilter(value)}>
                {label}<span>{count}</span>
              </button>
            ))}
          </div>
          <label className="search-field member-search">
            <Search />
            <input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="Search people or roles" aria-label="Search workspace members" />
          </label>
        </div>
        <div className="member-table-heading" aria-hidden="true">
          <span>Person</span><span>Status</span><span>Workspace roles</span><span>Groups</span><span />
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
                <span className="member-status-cell"><StatusBadge status={member.status} /></span>
                <span className="role-list">
                  {member.roles.map((role) => (
                    <span key={role}>{workspaceRoleLabel(role)}</span>
                  ))}
                </span>
                <span className="group-list">
                  {countPhrase(member.groupIds.length, "group")}
                </span>
                <ArrowRight />
              </button>
            ))
          ) : (
            <div className="member-search-empty">
              <Search />
              <strong>No members found</strong>
              <span>Try a different search or status filter.</span>
              <button type="button" className="button ghost small" onClick={() => { setMemberQuery(""); setMemberFilter("all"); }}>Clear filters</button>
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
                  {grant.email} · {workspaceRoleLabel(grant.role)} access granted{" "}
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
      <section className="card table-card invitations-directory directory-panel">
        <div className="section-heading compact directory-panel-header">
          <div>
            <p className="eyebrow">Invitation lifecycle</p>
            <h2>Invitations</h2>
          </div>
          <span className="result-count">{activeInvitationCount} pending</span>
        </div>
        {invitations.length ? (
          invitations.map((invite) => {
            const expired = Date.parse(invite.expiresAt) <= renderedAt;
            const status = invite.revokedAt
              ? "revoked"
              : invite.useCount >= invite.maxUses
                ? "accepted"
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
                    {invite.label || `${workspaceRoleLabel(invite.role)} invitation`}
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
            description="Invitations appear here after you send secure, exact-email access."
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
              label: workspaceRoleLabel(item),
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
  isCurrentUser,
  isPlatformOwner,
  busy,
  onClose,
  onSave,
  onSuspend,
}: {
  member: WorkspaceMember;
  isCurrentUser: boolean;
  isPlatformOwner: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (roles: WorkspaceRole[]) => Promise<void>;
  onSuspend: () => Promise<void>;
}) {
  const [roles, setRoles] = useState(member.roles);
  const { askToConfirm, dialog: confirmDialog } = useConfirmDialog();
  return (
    <Modal
      title={member.name || member.email}
      eyebrow="Member permissions"
      onClose={onClose}
      wide
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
        <section className="role-picker permission-section">
          <div className="permission-section-heading">
            <div><span className="field-label">Workspace roles</span><small>Select every role this person needs.</small></div>
            <span>{countPhrase(roles.length, "role")} selected</span>
          </div>
          {WORKSPACE_ROLES.map((role) => (
            <label className={`choice-row permission-option${roles.includes(role) ? " selected" : ""}`} key={role}>
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
                <strong>{workspaceRoleLabel(role)}</strong>
                <small>{ROLE_COPY[role]}</small>
              </span>
            </label>
          ))}
        </section>
        <PolicyNote icon={Shield} className="member-access-note">
          This member belongs to {countPhrase(member.groupIds.length, "group")} and may also receive workspace-wide or direct guide audiences.
        </PolicyNote>
        {isCurrentUser || isPlatformOwner ? (
          <PolicyNote icon={ShieldCheck} className="member-protected-note">
            {isPlatformOwner
              ? "This KnowHow owner account is protected from workspace suspension."
              : "You cannot suspend your own workspace account."}
          </PolicyNote>
        ) : (
          <section className="member-danger-zone">
          <div><strong>{member.status === "suspended" ? "Restore workspace access" : "Suspend workspace access"}</strong><small>{member.status === "suspended" ? "The member can sign in again after restoration." : "The member loses workspace access immediately; their content remains."}</small></div>
          <button
            className={member.status === "suspended" ? "button secondary" : "button danger-button"}
            type="button"
            disabled={busy}
            onClick={() => {
              void askToConfirm({
                title: member.status === "suspended" ? `Restore ${member.name || member.email}?` : `Suspend ${member.name || member.email}?`,
                description: member.status === "suspended" ? "Restore this member's workspace access?" : "They will lose workspace access immediately. Their guides and audit history remain.",
                confirmLabel: member.status === "suspended" ? "Restore member" : "Suspend member",
                tone: member.status === "suspended" ? "default" : "danger",
              }).then((confirmed) => { if (confirmed) void onSuspend(); });
            }}
          >
            {member.status === "suspended" ? "Restore" : "Suspend"}
          </button>
          </section>
        )}
        <footer className="modal-footer">
          <span />
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="button"
            disabled={busy || roles.length === 0}
            onClick={() => onSave(roles)}
          >
            <Check /> Save
          </button>
        </footer>
      </div>
      {confirmDialog}
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
      eyebrow="Workspace invitation"
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
                  ? "Invitation sent"
                  : `${created.length} invitations sent`}
              </strong>
              <p>
                We emailed each person. The link below is a one-time backup if
                the email is delayed.
              </p>
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
            <section className="invite-composer-section invite-recipients-section">
              <div className="form-section-heading">
                <span className="form-section-icon"><Mail /></span>
                <div><strong>Who are you inviting?</strong><small>Add up to {MAX_BULK_INVITES} exact email addresses.</small></div>
              </div>
            <label className="field invite-email-field">
              <span>Email addresses</span>
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
              {parsed.emails.length && !parsed.invalid.length ? (
                <span className="invite-ready-chip"><Check /> {countPhrase(parsed.emails.length, "address")} ready</span>
              ) : null}
            </label>
            </section>
            <section className="invite-composer-section invite-access-section">
              <div className="form-section-heading">
                <span className="form-section-icon"><UserCog /></span>
                <div><strong>Invitation access</strong><small>Choose the initial role, expiry, and an optional internal label.</small></div>
              </div>
            <div className="invite-settings">
              <label className="field">
                <span>Internal label <small>Optional</small></span>
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="August contractor onboarding"
                />
              </label>
              <div className="field">
                <span>Starting role</span>
                <SelectMenu
                  className="form-select"
                  value={role}
                  onChange={(value) => setRole(value as WorkspaceRole)}
                  ariaLabel="Invitation access"
                  options={[
                    { value: "viewer", label: "Viewer — can view shared guides" },
                    { value: "creator", label: "Creator — can create guides" },
                    { value: "reviewer", label: "Reviewer — reviews assigned drafts" },
                    { value: "publisher", label: "Publisher — publishes approved revisions" },
                  ]}
                />
                <small>
                  Roles are additive and can be adjusted after membership.
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
            </section>
            <PolicyNote icon={LockKeyhole} className="invite-security-note">
              Every invitation is exact-email, single-use, expiring, and audited. There are no generic invite links.
            </PolicyNote>
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
              {busy ? <LoaderCircle className="spin" /> : <Mail />}{" "}
              {parsed.emails.length > 1
                ? `Send ${parsed.emails.length} invitations`
                : "Send invitation"}
            </button>
          ) : null}
        </footer>
      </form>
    </Modal>
  );
}

function SupportView({
  workspaceId,
  tickets,
  busy,
  canCreate,
  onCreate,
  onReply,
  onClose,
}: {
  workspaceId: string;
  tickets: SupportTicket[];
  busy: boolean;
  canCreate: boolean;
  onCreate: (subject: string, message: string, attachmentIds: string[]) => Promise<void>;
  onReply: (ticketId: string, message: string) => Promise<void>;
  onClose: (ticketId: string) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState(tickets[0]?.id ?? "");
  const [creating, setCreating] = useState(canCreate);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [confirmingCloseId, setConfirmingCloseId] = useState("");
  const selected =
    tickets.find((ticket) => ticket.id === selectedId) ?? tickets[0];
  return (
    <div className="view-stack support-page">
      <div className="page-heading support-page-heading">
        <div>
          <p className="eyebrow">In-app support</p>
          <h1>Support</h1>
          <p>
            Get help from the KnowHow team through a private, workspace-scoped thread.
          </p>
        </div>
        <div className="support-heading-actions">
          {canCreate ? (
            <button className="button primary" type="button" disabled={busy || creating} onClick={() => {
              setSubject("");
              setMessage("");
              setAttachments([]);
              setCreating(true);
            }}>
              <Plus /> New request
            </button>
          ) : null}
        </div>
      </div>
      <div className={["support-layout", !tickets.length ? "is-empty" : "", creating ? "is-creating" : ""].filter(Boolean).join(" ")}>
        <aside className="card support-list" aria-label="Support tickets">
          <header className="support-list-header">
            <div><p className="eyebrow">Your requests</p><h2>{countPhrase(tickets.length, "conversation")}</h2></div>
            {tickets.length ? <span>{tickets.filter((ticket) => ticket.status !== "closed").length} active</span> : null}
          </header>
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
                setConfirmingCloseId("");
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
            <div className="support-list-empty">
              <LifeBuoy />
              <strong>No requests yet</strong>
              <small>Your support history will stay organized here.</small>
            </div>
          ) : null}
        </aside>
        <section className="card support-thread">
          {creating ? (
            <form
              className="modal-form support-composer"
              onSubmit={async (event) => {
                event.preventDefault();
                const uploadedIds: string[] = [];
                setUploadingAttachments(true);
                try {
                  for (const file of attachments) {
                    const uploaded = await uploadSupportAttachment(workspaceId, file);
                    uploadedIds.push(uploaded.id);
                  }
                  await onCreate(subject.trim(), message.trim(), uploadedIds);
                  setSubject("");
                  setMessage("");
                  setAttachments([]);
                  setCreating(false);
                } catch {
                  await Promise.allSettled(
                    uploadedIds.map((mediaId) =>
                      removeStagedSupportAttachment(workspaceId, mediaId),
                    ),
                  );
                } finally {
                  setUploadingAttachments(false);
                }
              }}
            >
              <header className="support-composer-header">
                <span><LifeBuoy /></span>
                <div>
                  <p className="eyebrow">New support request</p>
                  <h2>How can we help?</h2>
                  <p>Describe the issue and what you expected to happen.</p>
                </div>
              </header>
              <div className="support-privacy-note">
                <ShieldCheck />
                <div><strong>Keep sensitive data out</strong><p>Review messages and files before sending. Don’t include credentials, secrets, payment information, health data, or national IDs.</p></div>
              </div>
              <div className="support-composer-fields">
              <label className="field support-subject-field">
                <span>Subject <small>Summarize the problem</small></span>
                <input
                  required
                  minLength={4}
                  maxLength={160}
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  placeholder="What do you need help with?"
                />
              </label>
              <label className="field">
                <span>Details <small>Include steps to reproduce and any error text</small></span>
                <textarea
                  required
                  maxLength={4000}
                  rows={8}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Tell us what happened, what you tried, and the outcome you expected."
                />
              </label>
              <div className="support-attachment-field">
                <div>
                  <strong>Attachments</strong>
                  <small>Up to 5 files, 5 MB each · PNG, JPEG, WebP, PDF, JSON, CSV, or text</small>
                </div>
                <label className="button secondary support-attachment-picker">
                  <Paperclip /> Add files
                  <input
                    type="file"
                    multiple
                    accept=".png,.jpg,.jpeg,.webp,.pdf,.json,.csv,.txt,text/plain,text/csv,application/json,application/pdf,image/png,image/jpeg,image/webp"
                    onChange={(event) => {
                      const selectedFiles = Array.from(event.target.files ?? []);
                      const allowedTypes = new Set([
                        "application/json",
                        "application/pdf",
                        "image/jpeg",
                        "image/png",
                        "image/webp",
                        "text/csv",
                        "text/plain",
                      ]);
                      const next = [...attachments];
                      for (const file of selectedFiles) {
                        if (!file.size || file.size > 5 * 1024 * 1024) {
                          toast.error(`${file.name} must be between 1 byte and 5 MB.`);
                          continue;
                        }
                        if (!allowedTypes.has(file.type)) {
                          toast.error(`${file.name} is not a supported attachment type.`);
                          continue;
                        }
                        if (next.length >= 5) {
                          toast.error("You can attach up to 5 files.");
                          break;
                        }
                        if (!next.some((item) => item.name === file.name && item.size === file.size)) {
                          next.push(file);
                        }
                      }
                      setAttachments(next);
                      event.target.value = "";
                    }}
                  />
                </label>
                {attachments.length ? (
                  <ul className="support-attachment-list">
                    {attachments.map((file, index) => (
                      <li key={`${file.name}:${file.size}:${index}`}>
                        <Paperclip />
                        <span><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span>
                        <button
                          type="button"
                          className="icon-button tiny"
                          aria-label={`Remove ${file.name}`}
                          onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                        >
                          <X />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              </div>
              <footer className="modal-footer">
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => {
                    setAttachments([]);
                    setCreating(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="button primary"
                  type="submit"
                  disabled={
                    busy || uploadingAttachments ||
                    subject.trim().length < 4 ||
                    !message.trim()
                  }
                >
                  {busy || uploadingAttachments ? <LoaderCircle className="spin" /> : <LifeBuoy />} Send
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
                {selected.status === "closed" ? (
                  <span className="support-closed-pill">
                    <CheckCircle2 />
                    {selected.closureConfirmedAt ? "Closed with customer confirmation" : "Closed"}
                  </span>
                ) : null}
              </header>
              {selected.status === "resolved" ? (
                <div className="support-resolution-banner">
                  <CheckCircle2 />
                  <div>
                    <strong>KnowHow Support marked this resolved</strong>
                    <p>Confirm closure if the issue is fixed. If you still need help, reply below and the ticket will reopen.</p>
                  </div>
                  {confirmingCloseId === selected.id ? (
                    <div className="support-resolution-confirm">
                      <strong>Close this ticket permanently?</strong>
                      <button className="button secondary small" type="button" disabled={busy} onClick={() => setConfirmingCloseId("")}>
                        Not yet
                      </button>
                      <button
                        className="button primary small"
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          await onClose(selected.id);
                          setConfirmingCloseId("");
                        }}
                      >
                        {busy ? <LoaderCircle className="spin" /> : <CheckCircle2 />} Confirm & close
                      </button>
                    </div>
                  ) : (
                    <button className="button primary small" type="button" disabled={busy} onClick={() => setConfirmingCloseId(selected.id)}>
                      Confirm resolution
                    </button>
                  )}
                </div>
              ) : null}
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
                    {item.attachments.length ? (
                      <div className="support-message-attachments">
                        {item.attachments.map((attachment) => (
                          <a
                            href={supportAttachmentHref(workspaceId, attachment.id)}
                            key={attachment.id}
                          >
                            <Paperclip />
                            <span>{attachment.filename}</span>
                            <small>{formatBytes(attachment.byteSize)}</small>
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
              {selected.status !== "closed" ? (
                <form
                  className="support-reply"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (!message.trim()) return;
                    await onReply(selected.id, message.trim());
                    setMessage("");
                  }}
                >
                  <label className="field">
                    <span>{selected.status === "resolved" ? "Still need help? Reply to reopen" : "Reply"}</span>
                    <textarea
                      rows={4}
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
                    disabled={busy || !message.trim()}
                  >
                    {busy ? <LoaderCircle className="spin" /> : <ArrowRight />}{" "}
                    Reply
                  </button>
                </form>
              ) : null}
            </>
          ) : (
            <div className="support-welcome">
              <span className="support-welcome-icon"><LifeBuoy /></span>
              <p className="eyebrow">Private workspace support</p>
              <h2>Get help without leaving KnowHow</h2>
              <p>Start a private conversation with our support team. We target an initial response within one business day.</p>
              <div className="support-assurance-grid">
                <span><ShieldCheck /><strong>Workspace private</strong><small>Only authorized support staff can respond.</small></span>
                <span><Mail /><strong>Safe notifications</strong><small>Email notices never include message content.</small></span>
              </div>
              {canCreate ? <button className="button primary" type="button" disabled={busy} onClick={() => setCreating(true)}><Plus /> Start a support request</button> : null}
            </div>
          )}
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
  removeBrandingEnabled,
  onSave,
  onRefresh,
  onRegisterNavigationGuard,
}: {
  workspaceId: string;
  workspaceName: string;
  initial: WorkspaceSettings;
  busy: boolean;
  removeBrandingEnabled: boolean;
  onSave: (settings: WorkspaceSettings) => Promise<void>;
  onRefresh: () => Promise<BootstrapResponse>;
  onRegisterNavigationGuard: (guard: NavigationGuard | null) => void;
}) {
  const [settings, setSettings] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState("");
  const { askToConfirm, dialog: confirmDialog } = useConfirmDialog();
  const askToConfirmRef = useRef(askToConfirm);
  const dirty = JSON.stringify(settings) !== JSON.stringify(baseline);
  const dirtyRef = useRef(dirty);
  const colorsValid =
    isValidHexColor(settings.accentColor) &&
    isValidHexColor(settings.clickTargetColor);
  const update = <K extends keyof WorkspaceSettings>(
    key: K,
    value: WorkspaceSettings[K],
  ) => setSettings((current) => ({ ...current, [key]: value }));
  const disabled = busy || logoBusy;
  useEffect(() => {
    askToConfirmRef.current = askToConfirm;
  }, [askToConfirm]);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const guard: NavigationGuard = {
      shouldBlock: () => dirtyRef.current,
      requestConfirmation: ({ proceed }) => {
        void askToConfirmRef.current({
          title: "Discard unsaved settings?",
          description: "Your workspace policy and branding changes have not been saved.",
          confirmLabel: "Discard changes",
          tone: "danger",
        }).then((confirmed) => {
          if (!confirmed) return;
          dirtyRef.current = false;
          proceed();
        });
      },
    };
    window.addEventListener("beforeunload", beforeUnload);
    onRegisterNavigationGuard(guard);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      onRegisterNavigationGuard(null);
    };
  }, [onRegisterNavigationGuard]);

  async function saveSettings() {
    await onSave(settings);
    setBaseline(settings);
  }
  async function refreshLogoState() {
    const refreshed = await onRefresh();
    const logoUrl = refreshed.activeWorkspace?.workspace.settings.logoUrl;
    setSettings((current) => ({ ...current, logoUrl: logoUrl ?? null }));
    setBaseline((current) => ({ ...current, logoUrl: logoUrl ?? null }));
  }
  return (
    <div className="view-stack settings-page">
      <div className="page-heading settings-page-heading">
        <div>
          <p className="eyebrow">Workspace administration</p>
          <h1>Settings & policies</h1>
          <p>
            Manage how {workspaceName} looks, publishes, and protects its content.
          </p>
        </div>
      </div>
      <div className="settings-console">
        <div className="settings-main">
          <div className="settings-grid">
          <section className="card settings-card settings-card-general settings-section-wide">
            <div className="settings-title">
              <span><Settings /></span>
              <div>
                <h2>Workspace safeguards</h2>
                <p>Built-in protections that keep published knowledge controlled and auditable.</p>
              </div>
              <Badge variant="outline">Always on</Badge>
            </div>
            <div className="safeguard-list">
              <PolicyNote icon={ShieldCheck}>Captured screenshots require a recorded privacy review before publication.</PolicyNote>
            </div>
            <div className="settings-divider" />
            <label className="choice-row emphasized settings-toggle-row">
              <span className="settings-toggle-copy">
                <strong>Allow exact non-password text in Windows capture</strong>
                <small>
                  Authors still choose whether to capture typed text. Password and uncertain fields are saved as actions without their value.
                </small>
              </span>
              <input
                type="checkbox"
                checked={settings.desktopTypedTextPolicy === "allowed"}
                onChange={(event) =>
                  update(
                    "desktopTypedTextPolicy",
                    event.target.checked ? "allowed" : "disabled",
                  )
                }
              />
              <span className="settings-switch" aria-hidden="true" />
            </label>
          </section>
        <section className="card settings-card document-identity-card settings-section-wide">
          <div className="settings-title">
            <span>
              <Paintbrush />
            </span>
            <div>
              <h2>Document identity</h2>
              <p>Applied to the live guide experience and generated exports.</p>
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
                PNG or JPEG, up to 1 MB. Square marks and wide wordmarks both
                fit. The stored identifier remains private.
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
                  // Only the size is checked here. A browser types a file from
                  // its extension, so the raster's own magic bytes decide the
                  // format server-side.
                  if (file.size > 1024 * 1024) {
                    setLogoError("The logo must be no larger than 1 MB.");
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
              label="Workspace accent"
              ariaLabel="Pick workspace accent"
              hint="Tints the workspace interface, and brands guides, annotations, and exports."
            />
            <HexColorPicker
              value={settings.clickTargetColor}
              onChange={(value) => update("clickTargetColor", value)}
              label="Click target"
              ariaLabel="Pick click target color"
              hint="Marks the next click in recorded guide steps."
            />
          </div>
          <label className={`choice-row emphasized settings-toggle-row${removeBrandingEnabled ? "" : " locked-choice"}`}>
            <span className="settings-toggle-copy">
              <strong>
                Remove KnowHow branding
                {!removeBrandingEnabled ? <ProBadge size="sm" /> : null}
              </strong>
              <small>
                {removeBrandingEnabled
                  ? "KnowHow branding is hidden on exports for this workspace."
                  : "Locked on Free. Included on Pro trial, Pro, and Enterprise."}
              </small>
            </span>
            <input
              type="checkbox"
              checked={settings.removeBranding}
              disabled={!removeBrandingEnabled}
              onChange={(event) =>
                update("removeBranding", event.target.checked)
              }
            />
            <span className="settings-switch" aria-hidden="true" />
          </label>
          <div className="brand-preview settings-live-preview" style={{ "--preview-accent": settings.accentColor, "--click-color": settings.clickTargetColor } as React.CSSProperties}>
            <WorkspaceLogo workspaceId={workspaceId} workspaceName={workspaceName} logoKey={settings.logoUrl} size="md" />
            <span><strong>{workspaceName}</strong><small>Live guide and export preview</small></span>
          </div>
        </section>
        <section className="card settings-card settings-card-compact">
          <div className="settings-title">
            <span>
              <ShieldCheck />
            </span>
            <div>
              <h2>Publishing workflow</h2>
              <p>Choose whether working drafts require an assigned reviewer.</p>
            </div>
          </div>
          <label className="choice-row emphasized settings-toggle-row">
            <span className="settings-toggle-copy">
              <strong>Require review before publishing</strong>
              <small>Creators submit drafts to a Reviewer. Approved revisions are published by a Publisher.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.requireReviewBeforePublish}
              onChange={(event) =>
                update("requireReviewBeforePublish", event.target.checked)
              }
            />
            <span className="settings-switch" aria-hidden="true" />
          </label>
          <PolicyNote icon={LockKeyhole}>Administrators cannot bypass required review.</PolicyNote>
        </section>
        <section className="card settings-card settings-card-compact">
          <div className="settings-title">
            <span><FileDown /></span>
            <div><h2>Export controls</h2><p>Exports are static copies. Live links keep audience checks.</p></div>
          </div>
          <label className="choice-row emphasized settings-toggle-row">
            <span className="settings-toggle-copy">
              <strong>Allow restricted-guide exports</strong>
              <small>Each permitted export is recorded in the audit history.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.allowRestrictedExports}
              onChange={(event) =>
                update("allowRestrictedExports", event.target.checked)
              }
            />
            <span className="settings-switch" aria-hidden="true" />
          </label>
          <label className="choice-row emphasized settings-toggle-row">
            <span className="settings-toggle-copy">
              <strong>Watermark exports</strong>
              <small>Add viewer, workspace, and export date to generated files.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.watermarkExports}
              onChange={(event) =>
                update("watermarkExports", event.target.checked)
              }
            />
            <span className="settings-switch" aria-hidden="true" />
          </label>
        </section>
          </div>
        </div>
      </div>
      <footer className={`settings-save-bar${dirty ? " is-dirty" : ""}`}>
        <span>{dirty ? "Unsaved changes" : "All settings saved"}</span>
        {dirty ? (
          <button className="button secondary" type="button" disabled={disabled} onClick={() => setSettings(baseline)}>
            Discard
          </button>
        ) : null}
        <button className="button primary" type="button" disabled={disabled || !dirty || !colorsValid} onClick={() => void saveSettings()}>
          <Check /> Save changes
        </button>
      </footer>
      {confirmDialog}
    </div>
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
      description: "Full organization authority, including owner appointments and settings",
    },
    {
      value: "administrator",
      label: "Administrator",
      description: "Organization identity, people, and workspace directory without guide access",
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

function OrganizationIdentityCard({
  organization,
}: {
  organization: OrganizationAdministration;
}) {
  return (
    <section
      className="card settings-card organization-identity-card"
      style={{ "--organization-accent": organization.branding.accentColor } as React.CSSProperties}
    >
      <div className="settings-title organization-identity-heading">
        <span>
          <Building2 />
        </span>
        <div>
          <h2>Organization profile</h2>
          <p>Company identity and your administrative access.</p>
        </div>
      </div>
      <dl className="organization-metadata">
        <div>
          <dt>Legal name</dt>
          <dd>{organization.legalName || "Not provided"}</dd>
        </div>
        <div>
          <dt>Country</dt>
          <dd>{organization.country}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd><StatusBadge status={organization.status} /></dd>
        </div>
        <div>
          <dt>Your roles</dt>
          <dd className="organization-role-list">
            {organization.roles.map((role) => (
              <Badge className="organization-role-badge" variant="secondary" key={role}>
                <ShieldCheck /> {organizationRoleLabel(role)}
              </Badge>
            ))}
          </dd>
        </div>
      </dl>
      <p className="privacy-caption">
        <LockKeyhole /> Organization administrators manage people. They do
        not automatically see workspace guides.
      </p>
    </section>
  );
}

function OrganizationWorkspaceRow({
  workspace,
  busy,
  allowanceFull,
  canRenameWorkspace,
  canArchiveWorkspace,
  liveWorkspaceCount,
  renamingWorkspaceId,
  renameDraft,
  setRenameDraft,
  setRenamingWorkspaceId,
  onRenameWorkspace,
  onArchiveWorkspace,
  onRestoreWorkspace,
  askToConfirm,
}: {
  workspace: OrganizationAdministration["workspaces"][number];
  busy: boolean;
  allowanceFull: boolean;
  canRenameWorkspace: boolean;
  canArchiveWorkspace: boolean;
  liveWorkspaceCount: number;
  renamingWorkspaceId: string | null;
  renameDraft: string;
  setRenameDraft: (draft: string) => void;
  setRenamingWorkspaceId: (id: string | null) => void;
  onRenameWorkspace?: (workspaceId: string, name: string) => Promise<unknown>;
  onArchiveWorkspace?: (workspaceId: string, confirmation: string) => Promise<unknown>;
  onRestoreWorkspace?: (workspaceId: string) => Promise<unknown>;
  askToConfirm: ReturnType<typeof useConfirmDialog>["askToConfirm"];
}) {
  const isRenaming = renamingWorkspaceId === workspace.id;

  return (
    <div className="invite-row">
      <span className="invite-icon">
        <Building2 />
      </span>
      {isRenaming ? (
        <form
          className="member-main organization-rename-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const name = renameDraft.trim();
            if (name.length < 2 || name === workspace.name) {
              setRenamingWorkspaceId(null);
              return;
            }
            await onRenameWorkspace?.(workspace.id, name);
            setRenamingWorkspaceId(null);
          }}
        >
          <input
            autoFocus
            value={renameDraft}
            aria-label={`Rename ${workspace.name}`}
            maxLength={128}
            onChange={(event) => setRenameDraft(event.target.value)}
          />
          <small>
            The address stays {workspace.slug}, so shared links keep
            working.
          </small>
        </form>
      ) : (
        <span className="member-main">
          <strong>{workspace.name}</strong>
          <small>{workspace.slug}</small>
        </span>
      )}
      <StatusBadge status={workspace.status} />
      {workspace.status === "archived" ? (
        canArchiveWorkspace && onRestoreWorkspace ? (
          <span className="organization-workspace-actions">
            <Button
              variant="outline"
              size="sm"
              type="button"
              disabled={busy || allowanceFull}
              title={
                allowanceFull
                  ? "Restoring needs a free workspace slot."
                  : undefined
              }
              onClick={() => onRestoreWorkspace(workspace.id)}
            >
              <ArchiveRestore /> Restore
            </Button>
          </span>
        ) : null
      ) : canRenameWorkspace ? (
        isRenaming ? (
          <span className="organization-workspace-actions">
            <Button
              variant="outline"
              size="sm"
              type="button"
              disabled={busy}
              onClick={() => setRenamingWorkspaceId(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              type="button"
              disabled={busy || renameDraft.trim().length < 2}
              onClick={async () => {
                const name = renameDraft.trim();
                if (name === workspace.name) {
                  setRenamingWorkspaceId(null);
                  return;
                }
                await onRenameWorkspace?.(workspace.id, name);
                setRenamingWorkspaceId(null);
              }}
            >
              Save
            </Button>
          </span>
        ) : (
          <span className="organization-workspace-actions">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={busy}
              onClick={() => {
                setRenameDraft(workspace.name);
                setRenamingWorkspaceId(workspace.id);
              }}
            >
              <Pencil /> Rename
            </Button>
            {canArchiveWorkspace ? (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={busy || liveWorkspaceCount < 2}
                title={
                  liveWorkspaceCount < 2
                    ? "An organization keeps at least one live workspace."
                    : undefined
                }
                onClick={async () => {
                  const confirmed = await askToConfirm({
                    title: `Archive ${workspace.name}?`,
                    description:
                      "Its guides and members stay intact and the workspace can be restored, but nobody can open it while it is archived. This frees one workspace slot.",
                    confirmLabel: "Archive workspace",
                  });
                  if (!confirmed) return;
                  await onArchiveWorkspace?.(workspace.id, workspace.name);
                }}
              >
                <Archive /> Archive
              </Button>
            ) : null}
          </span>
        )
      ) : null}
    </div>
  );
}

function OrganizationMemberRow({
  member,
  busy,
  canManage,
  onEdit,
}: {
  member: OrganizationAdministration["members"][number];
  busy: boolean;
  canManage: boolean;
  onEdit: (memberId: string) => void;
}) {
  return (
    <div className="member-row">
      <span className="avatar">
        {initials(member.name, member.email)}
      </span>
      <span className="member-main">
        <strong>{member.name || member.email}</strong>
        <small>{member.email}</small>
        <span className="role-chips">
          {member.roles.map((role) => (
            <Badge className="organization-role-badge organization-member-role" variant="secondary" key={role}>
              <ShieldCheck /> {organizationRoleLabel(role)}
            </Badge>
          ))}
        </span>
      </span>
      <StatusBadge status={member.status} />
      {canManage ? (
        <button
          className="button ghost small"
          type="button"
          disabled={busy}
          onClick={() => onEdit(member.id)}
        >
          <UserCog /> Edit
        </button>
      ) : null}
    </div>
  );
}

export function OrganizationView({
  organization,
  busy,
  onAppoint,
  onUpdate,
  onRevokeAppointment,
  onCreateWorkspace,
  onRenameWorkspace,
  onArchiveWorkspace,
  onRestoreWorkspace,
}: {
  organization: OrganizationAdministration;
  busy: boolean;
  onCreateWorkspace: (name: string) => Promise<unknown>;
  /** Absent on the pre-workspace shell, where these controls are not offered. */
  onRenameWorkspace?: (workspaceId: string, name: string) => Promise<unknown>;
  onArchiveWorkspace?: (
    workspaceId: string,
    confirmation: string,
  ) => Promise<unknown>;
  onRestoreWorkspace?: (workspaceId: string) => Promise<unknown>;
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
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(
    null,
  );
  const [renameDraft, setRenameDraft] = useState("");
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const { askToConfirm, dialog: confirmDialog } = useConfirmDialog();
  const canManage = organization.roles.includes("owner");
  // Adding a workspace is open to administrators too, unlike member changes.
  const canAddWorkspace =
    canManage || organization.roles.includes("administrator");
  // Renaming follows adding; archiving takes a workspace away from everyone in
  // it, so it stays with the owner.
  const canRenameWorkspace = canAddWorkspace && Boolean(onRenameWorkspace);
  const canArchiveWorkspace = canManage && Boolean(onArchiveWorkspace);
  const liveWorkspaceCount = organization.workspaces.filter(
    (workspace) =>
      workspace.status !== "archived" && workspace.status !== "deleted",
  ).length;
  const activeOwnerCount = organization.members.filter(
    (member) => member.status === "active" && member.roles.includes("owner"),
  ).length;
  const editingMember = organization.members.find(
    (member) => member.id === editingMemberId,
  );
  const { allowance } = organization;
  const allowanceFull = allowance.used >= allowance.maximum;
  // A granted ceiling is not something a subscription bought, so it is never
  // described as one.
  const allowanceUnlockedBy =
    allowance.source === "override"
      ? `Your organization holds ${allowance.maximum} workspace slots.`
      : allowance.plan === "free"
        ? "Free organizations hold one workspace."
        : `Your ${planLabel(allowance.plan)} subscription unlocks ${allowance.maximum} workspace slots.`;
  const allowanceHint = allowanceFull
    ? `All ${countPhrase(allowance.maximum, "workspace slot")} are in use. Subscribe a workspace to Pro to unlock more, or archive one you no longer need.`
    : allowanceUnlockedBy;

  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Organization</p>
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
            <UserPlus /> Add organization member
          </button>
        ) : null}
      </div>
      <OrganizationIdentityCard organization={organization} />
      <section className="card table-card">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Workspace directory</p>
            <h2>
              {countPhrase(organization.workspaces.length, "workspace")}
            </h2>
          </div>
          {canAddWorkspace ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || allowanceFull}
              title={allowanceFull ? allowanceHint : undefined}
              onClick={() => setAddingWorkspace(true)}
            >
              <Plus /> Add workspace
            </Button>
          ) : (
            <ShieldCheck />
          )}
        </div>
        <div className="organization-allowance">
          <UsageMeter
            label="Workspaces"
            used={organization.allowance.used}
            maximum={organization.allowance.maximum}
          />
          <p className="privacy-caption">
            <LockKeyhole />{" "}
            {allowanceFull
              ? allowanceHint
              : `${allowanceUnlockedBy} Each workspace is billed on its own — a new one starts on Free until you subscribe it.`}
          </p>
        </div>
        {organization.workspaces.map((workspace) => (
          <OrganizationWorkspaceRow
            key={workspace.id}
            workspace={workspace}
            busy={busy}
            allowanceFull={allowanceFull}
            canRenameWorkspace={canRenameWorkspace}
            canArchiveWorkspace={canArchiveWorkspace}
            liveWorkspaceCount={liveWorkspaceCount}
            renamingWorkspaceId={renamingWorkspaceId}
            renameDraft={renameDraft}
            setRenameDraft={setRenameDraft}
            setRenamingWorkspaceId={setRenamingWorkspaceId}
            onRenameWorkspace={onRenameWorkspace}
            onArchiveWorkspace={onArchiveWorkspace}
            onRestoreWorkspace={onRestoreWorkspace}
            askToConfirm={askToConfirm}
          />
        ))}
      </section>
      {organization.members.length ? (
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Organization members</p>
              <h2>
                {countPhrase(organization.members.length, "organization member")}
              </h2>
            </div>
            <span className={activeOwnerCount < 2 ? "privacy-caption owner-warning" : "privacy-caption"}>
              <ShieldCheck /> {activeOwnerCount < 2 ? "Add a second owner" : `${activeOwnerCount} active owners · minimum two`}
            </span>
          </div>
          {organization.members.map((member) => (
            <OrganizationMemberRow
              key={member.id}
              member={member}
              busy={busy}
              canManage={canManage}
              onEdit={setEditingMemberId}
            />
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
                  void (async () => {
                    if (
                      !(await askToConfirm({
                        title: "Revoke appointment?",
                        description: `Revoke the appointment for ${appointment.email}?`,
                        confirmLabel: "Revoke appointment",
                        tone: "danger",
                      }))
                    )
                      return;
                    await onRevokeAppointment(appointment.id);
                  })();
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
      {addingWorkspace ? (
        <OrganizationWorkspaceDialog
          busy={busy}
          onClose={() => setAddingWorkspace(false)}
          onCreate={async (name) => {
            await onCreateWorkspace(name);
            setAddingWorkspace(false);
          }}
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
      {confirmDialog}
    </div>
  );
}

function OrganizationWorkspaceDialog({
  busy,
  onClose,
  onCreate,
}: {
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();

  async function submit() {
    if (trimmed.length < 2) {
      setError("Give the workspace a name of at least two characters.");
      return;
    }
    setError("");
    setSaving(true);
    try {
      await onCreate(trimmed);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Add a workspace" eyebrow="Organization" onClose={onClose}>
      <div className="modal-form">
        <p className="privacy-caption">
          A workspace is a separate library with its own members, guides, and
          settings. Nothing is shared between workspaces, which makes them the
          right fit for separate clients rather than separate teams — use groups
          for teams inside one library.
        </p>
        <label className="field">
          <span>Workspace name</span>
          <input
            value={name}
            autoFocus
            maxLength={128}
            placeholder="Client or business unit"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
        </label>
        <p className="privacy-caption">
          It starts on Free with you as its administrator, and inherits this
          organization&apos;s branding. Upgrade it separately when it needs Pro.
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="modal-footer">
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || saving || trimmed.length < 2}
            onClick={() => void submit()}
          >
            {saving ? <LoaderCircle className="spin" /> : <Plus />}
            Create workspace
          </Button>
        </footer>
      </div>
    </Modal>
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
      title="Add organization member"
      eyebrow="Organization appointment"
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
            <span>Record this change under</span>
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
  const { askToConfirm, dialog: confirmDialog } = useConfirmDialog();
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
            if (member.status === "active" && status === "revoked") {
              const confirmed = await askToConfirm({
                title: `Revoke ${member.name || member.email}'s organization membership?`,
                description: "Organization governance access ends immediately. Workspace memberships remain separate.",
                confirmLabel: "Revoke membership",
                tone: "danger",
              });
              if (!confirmed) return;
            }
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
      {confirmDialog}
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
  state: "checking" | "missing" | "error" | "unavailable" | "connected";
  onClose: () => void;
  onLink: (options?: { force?: boolean }) => Promise<unknown>;
  onRevoke: () => Promise<void>;
}) {
  const [connectionError, setConnectionError] = useState("");
  const stores = extensionStoreUrls();
  const { askToConfirm, dialog: confirmDialog } = useConfirmDialog();

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
      !(await askToConfirm({
        title: "Disconnect capture browsers?",
        description:
          "Revoke every browser paired by your account in this workspace?",
        confirmLabel: "Disconnect",
        tone: "danger",
      }))
    )
      return;
    await onRevoke();
    await relink();
  }

  return (
    <>
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
    {confirmDialog}
    </>
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
  const { askToConfirm, dialog: confirmDialog } = useConfirmDialog();

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
      !(await askToConfirm({
        title: "Turn off authenticator?",
        description:
          "Turn off authenticator protection? You will only need your password to sign in.",
        confirmLabel: "Turn off",
        tone: "danger",
      }))
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
      !(await askToConfirm({
        title: "Sign out other devices?",
        description:
          "Sign out every other browser and device? This session will stay signed in.",
        confirmLabel: "Sign out",
      }))
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
    <>
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
    {confirmDialog}
    </>
  );
}

function RouteOpening({ message }: { message: string }) {
  return (
    <main className="route-unavailable" role="status" aria-live="polite">
      <span className="opening-mark">K</span>
      <h1>{message}</h1>
      <p>Checking the latest workspace copy.</p>
    </main>
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
  const pendingSupportCount = supportRequests.filter(
    (item) => item.status === "pending",
  ).length;
  const [dialog, setDialog] = useState<DialogState>(null);
  const [setupMenuOpen, setSetupMenuOpen] = useState(false);
  const [shareDraft, setShareDraft] = useState<{
    audiences: Audience[];
    privacyReviewed: boolean;
  } | null>(null);
  const { askToConfirm, dialog: confirmDialog } = useConfirmDialog();
  const { resolvedTheme, setPreference } = useTheme();
  const roles = workspace.roles;
  const isAdmin = roles.includes("administrator");
  const canOpenAdministration = Boolean(
    data.viewer.platformRoles?.some((role) =>
      ["owner", "operations", "support"].includes(role),
    ),
  );
  const canCreate = isAdmin || roles.includes("creator");
  const entitlements = active.entitlements ?? {
    maximumUsers: 3,
    maximumCreators: 1,
    maximumGuides: 15,
    storageBytes: 1_000_000_000,
    extensionEnabled: true,
    desktopCaptureEnabled: false,
    supportEnabled: false,
    removeBranding: false,
    privacyToolsEnabled: false,
    fileExportsEnabled: false,
  };
  const workspaceMutable =
    workspace.status === "active" &&
    workspace.subscription?.access !== "read_only";
  const canCapture =
    canCreate && workspaceMutable && entitlements.extensionEnabled;
  const canDesktopCapture =
    canCreate && workspaceMutable && entitlements.desktopCaptureEnabled;
  const canAnyCapture = canCapture || canDesktopCapture;
  const canOpenSupport = entitlements.supportEnabled;
  // Paid workspaces carry their own mark in the top bar; Free workspaces and
  // workspaces without an uploaded logo keep the bar clean rather than showing
  // an initial the sidebar already displays.
  const showTopbarBrand =
    BRANDED_PLANS.has(workspace.subscription?.plan ?? "free") &&
    Boolean(workspace.settings.logoUrl);
  const canCreateSupportTicket =
    canOpenSupport &&
    !busy &&
    (isAdmin || roles.includes("creator"));
  const organization = data.organizations?.find(
    (item) => item.id === workspace.organizationId,
  );
  const requestedView: View =
    route.kind === "workspace-section"
      ? SECTION_TO_VIEW[route.section]
      : route.kind === "administration-client"
        ? "Administration"
        : route.kind === "guide-new" ||
            route.kind === "guide-view" ||
            route.kind === "guide-edit"
          ? "Guides"
          : "Overview";
  const view =
    requestedView === "Administration" && !canOpenAdministration
      ? "Overview"
      : requestedView;

  useEffect(() => {
    if (requestedView !== "Administration" || canOpenAdministration) return;
    onNavigate(workspaceHref(workspace.slug), { replace: true });
  }, [canOpenAdministration, onNavigate, requestedView, workspace.slug]);

  useEffect(() => {
    if (route.kind !== "workspace-section" || route.section !== "capture") return;
    onNavigate(workspaceHref(workspace.slug, "guides"), { replace: true });
  }, [onNavigate, route, workspace.slug]);

  const [extensionLink, setExtensionLink] = useState<
    "checking" | "missing" | "error" | "unavailable" | "connected"
  >("checking");
  const extensionCompanion = useMemo<ExtensionCompanion>(
    () => ({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      userName: data.viewer.name || data.viewer.email,
      theme: resolvedTheme === "dark" ? "dark" : "light",
      guides: companionGuidesFromWorkspace(guides, workspace.slug),
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
      setSetupMenuOpen(false);
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
      const denial = entitlementFromError(error);
      if (denial) {
        // A plan limit is not a failure to debug — show what is blocked and
        // how to lift it instead of a raw error string.
        onError("");
        setDialog({ type: "entitlement", ...denial });
      } else {
        onError(messageFromError(error));
      }
      throw error;
    } finally {
      onBusyChange(false);
    }
  }

  async function saveGuide(payload: GuideEditorPayload, silent = false) {
    return command<GuideSaveResult>(
      "saveGuide",
      payload,
      silent
        ? ""
        : payload.transition === "review"
          ? "Draft sent for review"
          : "Private draft saved",
    );
  }

  async function shareGuideFromEditor(payload: GuideEditorPayload) {
    const saved = await saveGuide({ ...payload, transition: "draft" }, true);
    if (!payload.audiences.length) {
      await command(
        "unshareGuide",
        { guideId: saved.guideId },
        "Guide is no longer shared",
      );
      return saved;
    }
    await command(
      "shareGuide",
      {
        guideId: saved.guideId,
        audiences: payload.audiences,
        privacyReviewed: payload.privacyReviewed,
      },
      `Guide published — ${audienceSuccessMessage(payload.audiences)}`,
    );
    return saved;
  }

  function openShareGuides(guidesToShare: Guide[]) {
    const guide = guidesToShare[0];
    if (!guide) return;
    const revision = guide.workingRevision ?? guide.publishedRevision;
    const current = revision?.audiences ?? [];
    setShareDraft({
      audiences: current,
      privacyReviewed: guidesToShare.every((item) =>
        Boolean((item.workingRevision ?? item.publishedRevision)?.privacyReviewedAt),
      ),
    });
    setDialog({ type: "share-guide", guides: guidesToShare });
  }

  function openShareGuide(guide: Guide) {
    openShareGuides([guide]);
  }

  function openExportGuides(guidesToExport: Guide[]) {
    if (!guidesToExport.length) return;
    setDialog({ type: "export-guide", guides: guidesToExport });
  }

  function toggleWorkspaceTheme() {
    const theme = resolvedTheme === "dark" ? "light" : "dark";
    window.localStorage.setItem(`knowhow-theme:${data.viewer.id}`, theme);
    setPreference(theme);
    void knowhowCommand("updateTheme", { theme }).catch((error) =>
      onError(messageFromError(error)),
    );
  }

  function navigateToView(nextView: View) {
    onNavigate(workspaceHref(workspace.slug, VIEW_TO_SECTION[nextView]));
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
    !(["Groups", "Members", "Settings"].includes(view) && !isAdmin) &&
    !(view === "Organization" && !organization);
  const publishedRestricted = Boolean(
    routeGuide?.publishedRevision &&
    !routeGuide.publishedRevision.audiences.some(
      (item) => item.kind === "workspace",
    ),
  );
  const canRestoreRouteGuide = Boolean(
    workspaceMutable &&
    routeGuide?.canRestore,
  );
  const publishedViewKey = useRef("");
  const missingGuideRefreshKey = useRef("");
  const [missingGuideRefresh, setMissingGuideRefresh] = useState<
    "idle" | "loading" | "failed"
  >("idle");

  /* eslint-disable react-hooks/set-state-in-effect -- missing-guide recovery follows the current route */
  useEffect(() => {
    if (!routeGuideId) {
      missingGuideRefreshKey.current = "";
      setMissingGuideRefresh("idle");
      return;
    }
    if (routeGuide) {
      setMissingGuideRefresh("idle");
      return;
    }
    const key = `${workspace.id}:${routeGuideId}`;
    if (missingGuideRefreshKey.current === key) {
      setMissingGuideRefresh((current) =>
        current === "loading" ? current : "failed",
      );
      return;
    }
    missingGuideRefreshKey.current = key;
    setMissingGuideRefresh("loading");
    void onRefresh()
      .then(() => {
        setMissingGuideRefresh((current) =>
          current === "loading" ? "failed" : current,
        );
      })
      .catch(() => {
        setMissingGuideRefresh((current) =>
          current === "loading" ? "failed" : current,
        );
      });
  }, [onRefresh, routeGuide, routeGuideId, workspace.id]);
  /* eslint-enable react-hooks/set-state-in-effect */

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

  const visibleNav = NAV_ITEMS.filter((item) => {
      if (item.view === "Support") return canOpenSupport;
      // The organization view renders nothing without an active membership.
      if (item.view === "Organization") return Boolean(organization);
      if (["Groups", "Members", "Settings"].includes(item.view)) return isAdmin;
      return true;
    });
  const workspaceNavigation = visibleNav.filter(({ view: item }) =>
    ["Overview", "Guides"].includes(item),
  );
  const peopleNavigation = visibleNav.filter(({ view: item }) =>
    ["Groups", "Members"].includes(item),
  );
  const governanceNavigation = visibleNav.filter(({ view: item }) =>
    ["Organization", "Settings"].includes(item),
  );
  const supportNavigation = visibleNav.filter(({ view: item }) => item === "Support");
  const onboardingAudience = isAdmin || canAnyCapture;
  const onboardingChecklist = active.onboarding.steps.filter(
    (step) => step.id !== "workspace_readiness",
  );
  const onboardingRemaining = onboardingChecklist.filter(
    (step) => !step.completed,
  ).length;
  const onboardingPercent = Math.round(
    ((onboardingChecklist.length - onboardingRemaining) /
      Math.max(1, onboardingChecklist.length)) *
      100,
  );
  const showSetupNav =
    onboardingAudience && onboardingRemaining > 0;
  const accessLabel = workspaceAccessLabel(roles);
  const showGuideCreateMenu =
    (view === "Overview" || view === "Guides") &&
    canCreate &&
    workspaceMutable;
  const guideCreateMenuProps = {
    busy,
    browserAvailable: canCapture,
    desktopPlanEnabled: entitlements.desktopCaptureEnabled,
    desktopAvailable: canDesktopCapture,
    extensionState: extensionLink,
    desktopDeviceCount: (active.desktopCaptureDevices ?? []).length,
    onManual: () => onNavigate(newGuideHref(workspace.slug)),
    onBrowser: () => setDialog({ type: "extension" } as const),
    onDesktop: () => setDialog({ type: "desktop" } as const),
    onOpenPlan: isAdmin
      ? () => setDialog({ type: "plan" } as const)
      : undefined,
  };

  // Only surfaces once the workspace is close to the cap — a limit it is
  // nowhere near is noise, not information.
  const guideLimitTone = usageTone(
    active.metrics.guides,
    entitlements.maximumGuides,
  );
  const guideLimitNotice =
    guideLimitTone === "ok" ? null : (
      <div className="guide-limit-notice" data-tone={guideLimitTone}>
        <UsageMeter
          label="Guides used"
          used={active.metrics.guides}
          maximum={entitlements.maximumGuides}
        />
        <p>
          {guideLimitTone === "full"
            ? "This workspace cannot create more guides. Archive one to free a slot, or upgrade for more."
            : "This workspace is close to its guide limit. Archiving a guide frees a slot."}
        </p>
        {isAdmin ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDialog({ type: "plan" })}
          >
            View plans
          </Button>
        ) : null}
      </div>
    );

  let primaryAction: {
    label: string;
    icon: typeof Plus;
    disabled: boolean;
    onClick: () => void;
  } | null = null;

  if (view === "Members" && isAdmin) {
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
  }
  const PrimaryActionIcon = primaryAction?.icon;
  const sharingGuides = dialog?.type === "share-guide" ? dialog.guides : [];
  const sharingGuide = sharingGuides[0] ?? null;
  const exportingGuides = dialog?.type === "export-guide" ? dialog.guides : [];
  const exportingGuide = exportingGuides[0] ?? null;
  const shareDialog =
    sharingGuide && shareDraft ? (
      <GuideShareDialog
        open
        title={sharingGuides.length > 1
          ? `${sharingGuides.length} selected guides`
          : sharingGuide.workingRevision?.title ??
            sharingGuide.publishedRevision?.title ??
            sharingGuide.title}
        workspaceName={workspace.name}
        liveUrl={
          sharingGuides.length === 1 && sharingGuide.publishedRevision
            ? liveGuideUrl(window.location.origin, workspace.slug, sharingGuide)
            : ""
        }
        isLive={sharingGuides.every((guide) => Boolean(guide.publishedRevision))}
        audiences={shareDraft.audiences}
        groups={groups}
        members={members}
        captured={
          sharingGuides.some((guide) =>
            isCapturedGuideSource(
              (guide.workingRevision ?? guide.publishedRevision)?.source,
            ),
          )
        }
        privacyReviewed={shareDraft.privacyReviewed}
        canShare={sharingGuides.every((guide) => guide.canShare)}
        canRequestReview={Boolean(
          sharingGuides.length === 1 &&
            workspace.settings.requireReviewBeforePublish &&
            sharingGuide.canEdit &&
            sharingGuide.workingRevision &&
            sharingGuide.workingRevision.status === "draft",
        )}
        busy={busy || !workspaceMutable}
        onClose={() => {
          setDialog(null);
          setShareDraft(null);
        }}
        onAudiencesChange={(audiences) =>
          setShareDraft((current) =>
            current ? { ...current, audiences } : current,
          )
        }
        onPrivacyReviewedChange={(privacyReviewed) =>
          setShareDraft((current) =>
            current ? { ...current, privacyReviewed } : current,
          )
        }
        onShare={async () => {
          for (const guide of sharingGuides) {
            if (guide.publishedRevision && !shareDraft.audiences.length) {
              await command("unshareGuide", { guideId: guide.id }, "");
            } else {
              await command(
                "shareGuide",
                {
                  guideId: guide.id,
                  audiences: shareDraft.audiences,
                  privacyReviewed: shareDraft.privacyReviewed,
                },
                "",
              );
            }
          }
          toast.success(
            sharingGuides.length === 1
              ? `${sharingGuide.publishedRevision ? "Access updated" : "Guide published"} — ${audienceSuccessMessage(shareDraft.audiences)}`
              : `${sharingGuides.length} guides updated — ${audienceSuccessMessage(shareDraft.audiences)}`,
          );
          setDialog(null);
          setShareDraft(null);
        }}
        onRequestReview={
          sharingGuide.workingRevision
            ? async () => {
                const revision = sharingGuide.workingRevision!;
                await command(
                  "saveGuide",
                  {
                    guideId: sharingGuide.id,
                    revisionId: revision.id,
                    title: revision.title,
                    summary: revision.summary || revision.title,
                    category: revision.category,
                    tags: revision.tags,
                    systemReferences: revision.systemReferences,
                    steps: revision.steps,
                    audiences: shareDraft.audiences,
                    privacyReviewed: shareDraft.privacyReviewed,
                    source: revision.source,
                    transition: "review",
                  },
                  "Draft sent for review",
                );
                setDialog(null);
                setShareDraft(null);
              }
            : undefined
        }
      />
    ) : null;
  const exportDialog = exportingGuide ? (
    <GuideExportDialog
      open
      title={exportingGuides.length > 1
        ? `${exportingGuides.length} selected guides`
        : exportingGuide.workingRevision?.title ??
          exportingGuide.publishedRevision?.title ??
          exportingGuide.title}
      restricted={exportingGuides.some((guide) => Boolean(
        !guide.workingRevision && guide.publishedRevision &&
          !guide.publishedRevision.audiences.some((audience) => audience.kind === "workspace"),
      ))}
      fileExportsEnabled={entitlements.fileExportsEnabled}
      canExport={exportingGuides.every((guide) => Boolean(
        guide.workingRevision ||
          (guide.publishedRevision &&
            (guide.publishedRevision.audiences.some((audience) => audience.kind === "workspace") ||
              workspace.settings.allowRestrictedExports)),
      ))}
      busy={busy || !workspaceMutable}
      onClose={() => setDialog(null)}
      onExport={async (format: GuideExportFormatChoice) => {
        for (const guide of exportingGuides) {
          await downloadAuthorizedExport(workspace.id, guide.id, format);
        }
        toast.success(exportingGuides.length === 1
          ? "Export ready"
          : `${exportingGuides.length} exports ready`);
      }}
      onStartTrial={isAdmin ? () => setDialog({ type: "plan" }) : undefined}
    />
  ) : null;

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
    if (route.kind === "guide-edit" && !editorGuide && missingGuideRefresh === "loading") {
      return <RouteOpening message="Opening the captured guide" />;
    }
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
          privacyToolsEnabled={entitlements.privacyToolsEnabled}
          onClose={() => onNavigate(workspaceHref(workspace.slug, "guides"))}
          onSave={saveGuide}
          onShare={shareGuideFromEditor}
          requireReviewBeforePublish={workspace.settings.requireReviewBeforePublish}
          canShare={
            editorGuide?.canShare ??
            (isAdmin ||
              roles.includes("publisher") ||
              !workspace.settings.requireReviewBeforePublish)
          }
          liveUrl={
            editorGuide?.publishedRevision
              ? liveGuideUrl(
                  typeof window === "undefined" ? "" : window.location.origin,
                  workspace.slug,
                  editorGuide,
                )
              : ""
          }
          fileExportsEnabled={entitlements.fileExportsEnabled}
          canExport={
            Boolean(editorGuide?.workingRevision) ||
            Boolean(
              editorGuide?.publishedRevision &&
                (!publishedRestricted || workspace.settings.allowRestrictedExports),
            )
          }
          onExport={
            editorGuide
              ? async (format) => {
                  await downloadAuthorizedExport(
                    workspace.id,
                    editorGuide.id,
                    format,
                  );
                  toast.success("Export ready");
                }
              : undefined
          }
          onStartTrial={isAdmin ? () => setDialog({ type: "plan" }) : undefined}
          onSaved={(result, transition) => {
            if (!editorGuide) {
              onNavigate(guideEditorHref(workspace.slug, result.guideId), {
                replace: true,
              });
              return;
            }
            if (transition === "review") {
              onNavigate(workspaceHref(workspace.slug, "guides"), {
                replace: true,
              });
            }
            if (transition === "share") {
              onNavigate(
                guideHref(workspace.slug, result.guideId, "published"),
                { replace: true },
              );
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
    if (!routeGuide && missingGuideRefresh === "loading") {
      return <RouteOpening message="Opening the guide" />;
    }
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
          liveUrl={liveGuideUrl(window.location.origin, workspace.slug, routeGuide)}
          canExport={
            Boolean(routeGuide.workingRevision) ||
            Boolean(
              routeGuide.publishedRevision &&
                (!publishedRestricted || workspace.settings.allowRestrictedExports),
            )
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
          onShare={
            routeGuide.status !== "archived"
              ? () => openShareGuide(routeGuide)
              : undefined
          }
          onReact={(reaction) => {
            void knowhowCommand("recordGuideReaction", {
              workspaceId: workspace.id,
              guideId: routeGuide.id,
              reaction,
            })
              .then(() => onRefresh())
              .catch(() => undefined);
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
            void (async () => {
              if (
                !(await askToConfirm({
                  title: "Restore as a private draft?",
                  description:
                    "This creates a new editable draft from the selected revision. The archived version stays in history and nothing is published automatically.",
                  confirmLabel: "Restore as draft",
                }))
              )
                return;
              await command(
                "restoreRevision",
                { guideId: routeGuide.id, revisionId },
                "Guide restored as a private draft",
              );
              onNavigate(guideEditorHref(workspace.slug, routeGuide.id), {
                replace: true,
              });
            })().catch(() => undefined);
          }}
        />
        {shareDialog}
        {exportDialog}
        {confirmDialog}
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
          isAdmin
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
        <Sidebar className="sidebar" collapsible="icon">
          <SidebarHeader className="workspace-sidebar-header">
            <div className="sidebar-brand-row">
              <div className="sidebar-brand">
                <ProductBrand compact />
              </div>
              <button
                className="sidebar-notifications-button"
                type="button"
                aria-label="Notifications"
                title="Notifications"
                onClick={() => toast("Notifications are coming soon")}
              >
                <Bell aria-hidden="true" />
              </button>
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
                <span className="workspace-menu-copy">
                  <span className="workspace-menu-title">
                    <strong>{workspace.name}</strong>
                    {workspace.subscription?.plan === "pro" ||
                    workspace.subscription?.plan === "pro_trial" ? (
                      <ProBadge
                        label={workspacePlanLabel(workspace.subscription)}
                        size="sm"
                      />
                    ) : (
                      <span className="workspace-plan-chip">
                        {workspacePlanLabel(workspace.subscription)}
                      </span>
                    )}
                  </span>
                  <small>{workspaceAccessLabel(roles)}</small>
                </span>
              )}
            />
          </SidebarHeader>
          <SidebarContent>
            <>
                <SidebarGroup className="workspace-nav-group">
                  <p className="sidebar-section-label">Daily work</p>
                  <nav className="main-nav" aria-label="Workspace navigation">
                    <SidebarMenu>
                      {workspaceNavigation.map(({ view: item, icon: Icon }) => (
                        <SidebarMenuItem key={item}>
                          <SidebarMenuButton
                            isActive={view === item}
                            tooltip={NAV_LABELS[item]}
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
                    </SidebarMenu>
                  </nav>
                </SidebarGroup>
                {peopleNavigation.length ? (
                  <SidebarGroup className="workspace-nav-group people-nav-group">
                    <p className="sidebar-section-label">People & access</p>
                    <nav className="main-nav" aria-label="People and access navigation">
                      <SidebarMenu>
                        {peopleNavigation.map(({ view: item, icon: Icon }) => (
                          <SidebarMenuItem key={item}>
                            <SidebarMenuButton isActive={view === item} tooltip={NAV_LABELS[item]} type="button" onClick={() => navigateToView(item)}>
                              <Icon /><span>{NAV_LABELS[item]}</span>
                            </SidebarMenuButton>
                            {item === "Members" && pendingSupportCount ? <SidebarMenuBadge className="nav-badge">{pendingSupportCount}</SidebarMenuBadge> : null}
                          </SidebarMenuItem>
                        ))}
                      </SidebarMenu>
                    </nav>
                  </SidebarGroup>
                ) : null}
                {governanceNavigation.length ? (
                  <SidebarGroup className="workspace-nav-group governance-nav-group">
                    <p className="sidebar-section-label">Workspace</p>
                    <nav
                      className="main-nav"
                      aria-label="Workspace administration navigation"
                    >
                      <SidebarMenu>
                        {governanceNavigation.map(({ view: item, icon: Icon }) => (
                          <SidebarMenuItem key={item}>
                            <SidebarMenuButton
                              isActive={view === item}
                              tooltip={NAV_LABELS[item]}
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
                {canOpenAdministration ? (
                  <SidebarGroup className="workspace-nav-group administration-nav-group">
                    <p className="sidebar-section-label">Administration</p>
                    <nav
                      className="main-nav"
                      aria-label="KnowHow administration navigation"
                    >
                      <SidebarMenu>
                        <SidebarMenuItem>
                          <SidebarMenuButton
                            isActive={view === "Administration"}
                            tooltip="KnowHow Administration"
                            type="button"
                            onClick={() =>
                              onNavigate(
                                workspaceHref(workspace.slug, "administration"),
                              )
                            }
                          >
                            <ShieldCheck />
                            <span>KnowHow Administration</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      </SidebarMenu>
                    </nav>
                  </SidebarGroup>
                ) : null}
                {supportNavigation.length || showSetupNav ? (
                  <SidebarGroup className="workspace-nav-group support-nav-group">
                    <nav className="main-nav" aria-label="Help navigation">
                      <SidebarMenu>
                        {showSetupNav ? (
                          <SidebarMenuItem className="sidebar-setup-menu-item">
                            <Popover open={setupMenuOpen} onOpenChange={setSetupMenuOpen}>
                              <PopoverTrigger
                                render={
                                  <SidebarMenuButton
                                    className="sidebar-setup-trigger"
                                    title="Getting started"
                                    isActive={setupMenuOpen}
                                    type="button"
                                  />
                                }
                              >
                                <ClipboardCheck />
                                <span>Getting started</span>
                                <span className="sidebar-setup-meta">
                                  <span
                                    className="sidebar-setup-progress-ring"
                                    style={{
                                      "--setup-progress": `${onboardingPercent}%`,
                                    } as React.CSSProperties}
                                    aria-label={`${onboardingPercent}% complete`}
                                  >
                                    <span>{onboardingPercent}</span>
                                  </span>
                                  <ChevronRight className="sidebar-setup-chevron" />
                                </span>
                              </PopoverTrigger>
                              <PopoverContent
                                align="end"
                                side="right"
                                sideOffset={12}
                                initialFocus={false}
                                className="sidebar-onboarding-popover"
                              >
                                <SetupWizard
                                  onboarding={active.onboarding}
                                  busy={busy}
                                  canCapture={canCapture}
                                  captureLockedByPlan={!canAnyCapture && canCreate}
                                  canManageAccess={isAdmin}
                                  chrome="popover"
                                  onClose={() => setSetupMenuOpen(false)}
                                  onConfirmReadiness={() =>
                                    command(
                                      "confirmOnboardingReadiness",
                                      {
                                        ordinaryDataOnly: true,
                                        policiesReviewed: true,
                                      },
                                      "Workspace readiness confirmed.",
                                    )
                                  }
                                  onNavigate={(item) => {
                                    setSetupMenuOpen(false);
                                    navigateToView(item);
                                  }}
                                  onOpenExtension={() => {
                                    setSetupMenuOpen(false);
                                    setDialog({ type: "extension" });
                                  }}
                                  onPinExtension={() =>
                                    command(
                                      "confirmExtensionPinned",
                                      {},
                                      "Extension marked as pinned.",
                                    )
                                  }
                                  onDismiss={() =>
                                    command(
                                      "dismissOnboarding",
                                      {},
                                      "Getting started dismissed.",
                                    )
                                  }
                                />
                              </PopoverContent>
                            </Popover>
                          </SidebarMenuItem>
                        ) : null}
                        {supportNavigation.map(({ view: item, icon: Icon }) => (
                          <SidebarMenuItem key={item}>
                            <SidebarMenuButton isActive={view === item} tooltip={NAV_LABELS[item]} type="button" onClick={() => navigateToView(item)}>
                              <Icon /><span>Help & support</span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        ))}
                      </SidebarMenu>
                    </nav>
                  </SidebarGroup>
                ) : null}
            </>
          </SidebarContent>
        </Sidebar>

        <div className="app-main">
          <header className="topbar">
            <div className="topbar-start">
              <SidebarTrigger className="mobile-menu" />
              {showTopbarBrand ? (
                <>
                  <WorkspaceLogo
                    className="topbar-brand-logo"
                    workspaceId={workspace.id}
                    workspaceName={workspace.name}
                    logoKey={workspace.settings.logoUrl}
                    size="sm"
                  />
                  <span className="topbar-brand-divider" aria-hidden="true" />
                </>
              ) : null}
              <strong className="topbar-page-title">{NAV_LABELS[view]}</strong>
            </div>
            <div className="topbar-search-slot">
              {guides.length &&
                ![
                  "Organization",
                  "Settings",
                  "Support",
                  "Administration",
                ].includes(view) ? (
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
                onClick={toggleWorkspaceTheme}
              >
                {resolvedTheme === "dark" ? <Sun /> : <Moon />}
              </Button>
              {showGuideCreateMenu ? (
                <GuideCreateMenu {...guideCreateMenuProps} />
              ) : primaryAction && PrimaryActionIcon ? (
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
                captureLockedByPlan={
                  !entitlements.extensionEnabled &&
                  !entitlements.desktopCaptureEnabled
                }
                canManageAccess={isAdmin}
                busy={busy}
                newGuideAction={
                  <GuideCreateMenu
                    {...guideCreateMenuProps}
                    appearance="button"
                  />
                }
                newGuideCardAction={
                  <GuideCreateMenu
                    {...guideCreateMenuProps}
                    appearance="card"
                  />
                }
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
                onPinExtension={() =>
                  command("confirmExtensionPinned", {}, "").then(() => undefined)
                }
                onDismiss={() =>
                  command("dismissOnboarding", {}, "").then(() => undefined)
                }
              />
            ) : null}
            {view === "Guides" ? (
              <GuidesView
                guides={guides}
                canCreate={canCreate && workspaceMutable}
                newGuideAction={
                  <GuideCreateMenu
                    {...guideCreateMenuProps}
                    appearance="button"
                    label="Create guide"
                  />
                }
                guideLimitNotice={guideLimitNotice}
                onOpen={(guide) => openGuide(guide)}
                onEdit={(guide) =>
                  onNavigate(guideEditorHref(workspace.slug, guide.id))
                }
                onShare={openShareGuides}
                onExport={openExportGuides}
                onAction={command}
                busy={busy || !workspaceMutable}
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
                onEdit={(member) => setDialog({ type: "member", member })}
                onRevoke={(invitationId) => {
                  void askToConfirm({
                    title: "Revoke this invitation?",
                    description: "The signed link will stop working immediately. Existing membership is unaffected.",
                    confirmLabel: "Revoke invitation",
                    tone: "danger",
                  }).then((confirmed) => {
                    if (!confirmed) return;
                    void command(
                      "revokeInvite",
                      { invitationId },
                      "Invitation revoked",
                    ).catch(() => undefined);
                  });
                }}
                onResolveSupport={(request) =>
                  setDialog({ type: "support-decision", request })
                }
                onRevokeSupport={(grant) => {
                  void (async () => {
                    if (
                      !(await askToConfirm({
                        title: "Revoke temporary access?",
                        description: `Revoke ${grant.displayName || grant.email}'s temporary access now?`,
                        confirmLabel: "Revoke",
                        tone: "danger",
                      }))
                    )
                      return;
                    await command(
                      "revokeSupportAccess",
                      { grantId: grant.id },
                      "Temporary support access revoked",
                    ).catch(() => undefined);
                  })();
                }}
              />
            ) : null}
            {view === "Support" ? (
              canOpenSupport ? (
              <SupportView
                workspaceId={workspace.id}
                tickets={supportTickets}
                busy={busy || !workspaceMutable}
                canCreate={canCreateSupportTicket && workspaceMutable}
                onCreate={async (subject, message, attachmentIds) => {
                  await command(
                    "createSupportTicket",
                    { subject, message, attachmentIds },
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
                    "Resolution confirmed — ticket closed",
                  );
                }}
              />
              ) : (
                <EmptyState
                  icon={LifeBuoy}
                  title="Support is on Pro"
                  description="In-app tickets are included on Pro trial, Pro, and Enterprise. Free workspaces can use the contact form."
                  action={
                    isAdmin ? (
                      <Button onClick={() => setDialog({ type: "plan" })}>
                        View plans
                      </Button>
                    ) : undefined
                  }
                />
              )
            ) : null}
            {view === "Organization" && organization ? (
              <OrganizationView
                organization={organization}
                busy={busy}
                onCreateWorkspace={async (name) => {
                  const created = await command<{ workspaceId: string }>(
                    "createOrganizationWorkspace",
                    {
                      organizationId: organization.id,
                      workspaceId: undefined,
                      name,
                    },
                    `${name} workspace created`,
                  );
                  // Land the admin in the workspace they just made.
                  await onSelectWorkspace(created.workspaceId);
                  return created;
                }}
                onRenameWorkspace={(workspaceId, name) =>
                  command(
                    "renameOrganizationWorkspace",
                    {
                      organizationId: organization.id,
                      workspaceId: undefined,
                      targetWorkspaceId: workspaceId,
                      name,
                    },
                    `Workspace renamed to ${name}`,
                  )
                }
                onRestoreWorkspace={(workspaceId) =>
                  command(
                    "restoreOrganizationWorkspace",
                    {
                      organizationId: organization.id,
                      workspaceId: undefined,
                      targetWorkspaceId: workspaceId,
                    },
                    "Workspace restored",
                  )
                }
                onArchiveWorkspace={(workspaceId, confirmation) =>
                  command(
                    "archiveOrganizationWorkspace",
                    {
                      organizationId: organization.id,
                      workspaceId: undefined,
                      targetWorkspaceId: workspaceId,
                      confirmation,
                    },
                    `${confirmation} archived`,
                  )
                }
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
            {view === "Administration" && canOpenAdministration ? (
              <AdministrationView
                viewer={data.viewer}
                clientRouteId={
                  route.kind === "administration-client"
                    ? route.organizationId
                    : ""
                }
                onOpenClientRoute={(organizationId) =>
                  onNavigate(
                    organizationId
                      ? administrationClientHref(workspace.slug, organizationId)
                      : workspaceHref(workspace.slug, "administration"),
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
                removeBrandingEnabled={entitlements.removeBranding}
                onRefresh={onRefresh}
                onRegisterNavigationGuard={onRegisterNavigationGuard}
                onSave={async (settings) => {
                  await command(
                    "updateWorkspaceSettings",
                    { settings },
                    "Workspace policies and branding updated",
                  );
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
            isCurrentUser={dialog.member.userId === data.viewer.id}
            isPlatformOwner={Boolean(
              dialog.member.userId === data.viewer.id &&
                data.viewer.platformRoles?.includes("owner"),
            )}
            busy={busy}
            onClose={() => setDialog(null)}
            onSave={async (nextRoles) => {
              await command(
                "updateMember",
                {
                  memberId: dialog.member.id,
                  roles: nextRoles,
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
        {dialog?.type === "entitlement" ? (
          <Modal
            title="Upgrade required"
            eyebrow="Workspace plan"
            onClose={() => setDialog(null)}
          >
            <div className="modal-form">
              <ProUpsell
                onUpgrade={
                  isAdmin ? () => setDialog({ type: "plan" }) : undefined
                }
                upgradeLabel="See plan options"
              >
                {dialog.message}
              </ProUpsell>
              <footer className="modal-footer">
                <span />
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => setDialog(null)}
                >
                  Close
                </Button>
              </footer>
            </div>
          </Modal>
        ) : null}
        {dialog?.type === "plan" && isAdmin ? (
          <PlanDialog
            subscription={workspace.subscription}
            entitlements={entitlements}
            metrics={active.metrics}
            busy={busy}
            onClose={() => setDialog(null)}
            onStartTrial={async () => {
              await command(
                "startProTrial",
                { workspaceId: workspace.id },
                "Pro trial started — no payment method required",
              );
              setDialog(null);
            }}
            onSelectPro={async () => {
              await command(
                "selectProPlan",
                { workspaceId: workspace.id },
                "Pro request sent — we will contact you",
              );
              setDialog(null);
            }}
            onRequestEnterprise={async () => {
              await command(
                "requestEnterprisePlan",
                { workspaceId: workspace.id },
                "Enterprise request sent",
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
                    ? "Invitation sent"
                    : `${created.length} invitations sent`,
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
        {dialog?.type === "desktop" && canDesktopCapture ? (
          <DesktopCaptureDialog
            desktopDevices={active.desktopCaptureDevices ?? []}
            typedTextPolicy={workspace.settings.desktopTypedTextPolicy}
            busy={busy || !workspaceMutable}
            onClose={() => setDialog(null)}
            onRevokeDesktopDevice={async (deviceRecordId) => {
              if (
                !(await askToConfirm({
                  title: "Revoke this Windows device?",
                  description:
                    "The app will be disconnected immediately and must be approved again before another capture.",
                  confirmLabel: "Revoke device",
                  tone: "danger",
                }))
              )
                return;
              await command(
                "revokeDesktopDevice",
                { deviceRecordId },
                "Windows capture device revoked",
              );
            }}
          />
        ) : null}
        {shareDialog}
        {exportDialog}
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
        {confirmDialog}
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
  const contactEmailValid = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(
    primaryContactEmail.trim(),
  );
  const identityStepReady =
    legalName.trim().length >= 2 &&
    displayName.trim().length >= 2 &&
    primaryContactName.trim().length >= 2 &&
    contactEmailValid &&
    country.trim().length === 2;

  const stepLabels = [
    "Identity",
    "Branding",
    "Workspaces",
    "Contract",
    "Owners",
    "Invites",
  ];

  function stepData(currentStep: number): Record<string, unknown> {
    if (currentStep === 1) {
      if (
        [legalName, displayName, primaryContactName].some(
          (value) => value.trim().length < 2,
        ) ||
        !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(primaryContactEmail.trim()) ||
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
      label: `${invitation.email} · ${workspaceRoleLabel(invitation.role)} invitation`,
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
                  autoComplete="email"
                  pattern="^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$"
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
              Set contract dates and conservative capacity limits. Clients are
              invoiced offline.
            </p>
            <div className="form-grid two">
              <label className="field">
                <span>Contract start</span>
                <input
                  required
                  type="date"
                  value={pilotStart}
                  onChange={(event) => setPilotStart(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Contract end</span>
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
            disabled={working || (step === 1 && !identityStepReady)}
            onClick={() => void saveCurrent(false, true)}
          >
            Save & close
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={working || (step === 1 && !identityStepReady)}
          >
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

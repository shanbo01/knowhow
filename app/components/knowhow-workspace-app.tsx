"use client";

import {
  Archive,
  ArrowLeft,
  ArrowRight,
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
  Plus,
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
  GuideSearchResult,
  Invitation,
  OrganizationAdministration,
  OrganizationRole,
  PlatformProvisioningResult,
  PlatformProvisioningRun,
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
  | "Capture"
  | "Groups"
  | "Members"
  | "Support"
  | "Organization"
  | "Vault"
  | "Settings"
  | "Administration";

type DialogState =
  | null
  | { type: "group"; group: WorkspaceGroup | null }
  | { type: "invite" }
  | { type: "plan" }
  | { type: "member"; member: WorkspaceMember }
  | { type: "extension" }
  | { type: "share-guide"; guide: Guide }
  | { type: "export-guide"; guide: Guide }
  | { type: "account-security" }
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
  { view: "Settings", icon: Settings },
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
  Administration: "KnowHow Administration",
};

const VIEW_TO_SECTION: Record<View, WorkspaceSection> = {
  Overview: "overview",
  Guides: "guides",
  Capture: "capture",
  Groups: "groups",
  Members: "members",
  Support: "support",
  Organization: "organization",
  Vault: "vault",
  Settings: "settings",
  Administration: "administration",
};

const SECTION_TO_VIEW: Record<WorkspaceSection, View> = {
  overview: "Overview",
  guides: "Guides",
  capture: "Capture",
  groups: "Groups",
  members: "Members",
  support: "Support",
  organization: "Organization",
  vault: "Vault",
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

function audienceSuccessMessage(audiences: Audience[]) {
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

function workspacePlanLabel(
  subscription?: NonNullable<BootstrapResponse["activeWorkspace"]>["workspace"]["subscription"],
) {
  switch (subscription?.plan) {
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

function PlanDialog({
  subscription,
  entitlements,
  busy,
  onClose,
  onStartTrial,
  onSelectPro,
  onRequestEnterprise,
}: {
  subscription?: NonNullable<BootstrapResponse["activeWorkspace"]>["workspace"]["subscription"];
  entitlements: NonNullable<BootstrapResponse["activeWorkspace"]>["entitlements"];
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
        <ul className="privacy-caption">
          <li>Capture, Smart Blur, redact, and annotate: {entitlements.privacyToolsEnabled ? "included" : "Pro"}</li>
          <li>Custom subdomain: {entitlements.customSubdomainEnabled ? "included (preview)" : "Pro"}</li>
          <li>In-app support: {entitlements.supportEnabled ? "included" : "contact form on Free"}</li>
          <li>
            Limits: {entitlements.maximumCreators} creator
            {entitlements.maximumCreators === 1 ? "" : "s"}, {entitlements.maximumUsers} people
          </li>
        </ul>
        <footer className="modal-footer">
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
  chrome?: "card" | "plain";
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
  const completed = checklist.filter((step) => step.completed).length;
  const percent = checklist.length
    ? Math.round((completed / checklist.length) * 100)
    : 0;
  const current = checklist.find((step) => !step.completed);
  const readinessPending = Boolean(readiness && !readiness.completed);
  if (!current && !readinessPending) return null;
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
      if (canCapture) onNavigate("Capture");
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
          aria-label="Dismiss getting started"
          disabled={busy}
          onClick={() => void onDismiss()}
        >
          <X />
        </Button>
      </div>
      <DashboardProgress value={percent} label="Getting started progress" tone="accent" />
      {readinessPending ? (
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
        </>
      ) : null}
      <div className="onboarding-wizard-footer">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={busy}
          onClick={() => void onDismiss()}
        >
          Dismiss
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
  captureLockedByPlan,
  canManageAccess,
  busy,
  onNewGuide,
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
  onNewGuide: () => void;
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
          {canCreate ? (
            <Button type="button" onClick={onNewGuide}>
              <Plus /> New guide
            </Button>
          ) : null}
          {canCapture ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => onNavigate("Capture")}
            >
              <Sparkles /> Capture workflow
            </Button>
          ) : null}
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
                  ? "Capture a real workflow, write the first guide, or invite someone to try it with you."
                  : "Write the first guide, then share it with the people who need it."}
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
                        <BookOpen />
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

function GuidesView({
  guides,
  onNew,
  onOpen,
  onEdit,
  onShare,
  onExport,
  onAction,
  busy,
  canCreate,
}: {
  guides: Guide[];
  onNew: () => void;
  onOpen: (guide: Guide) => void;
  onEdit: (guide: Guide) => void;
  onShare: (guide: Guide) => void;
  onExport: (guide: Guide) => void;
  onAction: (
    action: string,
    payload: unknown,
    message: string,
  ) => Promise<void>;
  busy: boolean;
  canCreate: boolean;
}) {
  const [query, setQuery] = useState("");
  const [libraryTab, setLibraryTab] = useState<"shared" | "drafts">(() =>
    guides.some((guide) => guide.publishedRevision) ? "shared" : "drafts",
  );
  const [viewMode, setViewMode] = useState<"cards" | "list">("list");
  const [sort, setSort] = useState("updated");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<Guide | null>(null);
  const { askToConfirm, dialog: confirmDialog } = useConfirmDialog();
  const sharedCount = guides.filter((guide) => guide.publishedRevision).length;
  const draftCount = guides.filter((guide) => guide.workingRevision).length;
  const scopedGuides = guides.filter((guide) =>
    libraryTab === "shared"
      ? Boolean(guide.publishedRevision)
      : Boolean(guide.workingRevision),
  );
  const filtered = scopedGuides
    .filter((guide) => {
      const revision =
        libraryTab === "shared"
          ? guide.publishedRevision
          : guide.workingRevision;
      const text =
        `${guide.title} ${revision?.summary ?? ""} ${revision?.tags.join(" ") ?? ""}`.toLowerCase();
      return text.includes(query.toLowerCase());
    })
    .sort((left, right) => {
      if (sort === "title") return left.title.localeCompare(right.title);
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
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
            Draft privately, then share with the people who need the current
            procedure. Review stays available when your workspace requires it.
          </p>
        </div>
      </div>
      <section className="card table-card library-card">
        <div className="library-view-bar">
          <div className="library-tabs" role="tablist" aria-label="Guide collections">
            <button
              type="button"
              role="tab"
              aria-selected={libraryTab === "shared"}
              className={cn(libraryTab === "shared" && "is-active")}
              onClick={() => {
                setLibraryTab("shared");
                setPage(0);
              }}
            >
              Shared <span>{sharedCount}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={libraryTab === "drafts"}
              className={cn(libraryTab === "drafts" && "is-active")}
              onClick={() => {
                setLibraryTab("drafts");
                setPage(0);
              }}
            >
              Drafts <span>{draftCount}</span>
            </button>
          </div>
          <div className="library-layout-toggle" aria-label="Guide layout">
            <button
              type="button"
              className={cn(viewMode === "cards" && "is-active")}
              aria-label="Card view"
              aria-pressed={viewMode === "cards"}
              onClick={() => setViewMode("cards")}
            >
              <Grid2X2 />
            </button>
            <button
              type="button"
              className={cn(viewMode === "list" && "is-active")}
              aria-label="List view"
              aria-pressed={viewMode === "list"}
              onClick={() => setViewMode("list")}
            >
              <List />
            </button>
          </div>
        </div>
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
              value={sort}
              onChange={(value) => {
                setSort(value);
                setPage(0);
              }}
              ariaLabel="Sort guides"
              options={[
                { value: "updated", label: "Recently updated" },
                { value: "title", label: "Title A–Z" },
              ]}
            />
            <span className="result-count">
              {filtered.length} {filtered.length === 1 ? "guide" : "guides"}
            </span>
          </div>
        ) : null}
        {filtered.length ? (
          <div
            className={cn(
              "guide-table",
              viewMode === "cards" ? "is-card-view" : "is-list-view",
            )}
            role="tabpanel"
          >
            {visibleGuides.map((guide) => {
              const revision =
                libraryTab === "shared"
                  ? guide.publishedRevision
                  : guide.workingRevision;
              const live = guide.publishedRevision;
              return (
                <article
                  className="guide-card guide-card-clickable"
                  key={guide.id}
                  role="link"
                  tabIndex={0}
                  aria-label={`Open ${revision?.title ?? guide.title}`}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button, a, [role='menuitem']")) return;
                    onOpen(guide);
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpen(guide);
                    }
                  }}
                >
                  <div className="guide-card-main">
                    <span className="guide-icon large">
                      <BookOpen />
                    </span>
                    <span className="guide-content">
                      <span className="guide-title-line">
                        <strong>{revision?.title ?? guide.title}</strong>
                        {guide.restricted ? (
                          <span className="restricted-label">
                            <LockKeyhole /> Audience restricted
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
                        {revision?.steps.length ?? 0}{" "}
                        {(revision?.steps.length ?? 0) === 1 ? "step" : "steps"}
                        {guide.publishedRevision
                          ? ` · ${guide.viewCount ?? 0} ${(guide.viewCount ?? 0) === 1 ? "view" : "views"}`
                          : ""}{" "}
                        · Updated {formatDate(guide.updatedAt)}
                      </span>
                    </span>
                  </div>
                  <div className="guide-state-column">
                    <StatusBadge
                      status={libraryTab === "shared" ? "published" : guide.status}
                    />
                    {libraryTab === "drafts" && guide.workingRevision && live ? (
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
                        onClick={(event) => {
                          event.stopPropagation();
                          onEdit(guide);
                        }}
                      >
                        Edit
                      </button>
                    ) : null}
                    {guide.canShare && guide.status !== "archived" ? (
                      <button
                        className="button ghost small"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onShare(guide);
                        }}
                      >
                        Share
                      </button>
                    ) : null}
                    {guide.canReview && guide.status === "review" ? (
                      <>
                        <button
                          className="button secondary small"
                          disabled={busy}
                          type="button"
                          onClick={() => {
                            void (async () => {
                              const combined = guide.canPublish;
                              if (
                                !(await askToConfirm({
                                  title: combined
                                    ? "Approve and publish this revision?"
                                    : "Approve this revision?",
                                  description: combined
                                    ? "Approve this revision and make it live for its audience."
                                    : "Approve this revision for publication?",
                                  confirmLabel: combined
                                    ? "Approve and publish"
                                    : "Approve",
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
                            })();
                          }}
                        >
                          {guide.canPublish ? "Approve and publish" : "Approve"}
                        </button>
                        <button
                          className="button ghost small"
                          disabled={busy}
                          type="button"
                          onClick={() => {
                            void (async () => {
                              if (
                                !(await askToConfirm({
                                  title: "Request changes?",
                                  description:
                                    "Return this revision to its author for changes?",
                                  confirmLabel: "Request changes",
                                }))
                              )
                                return;
                              await onAction(
                                "reviewGuide",
                                {
                                  guideId: guide.id,
                                  decision: "changes_requested",
                                },
                                "Changes requested",
                              ).catch(() => undefined);
                            })();
                          }}
                        >
                          Request changes
                        </button>
                      </>
                    ) : null}
                    {guide.canPublish &&
                    guide.status === "review" &&
                    !guide.canReview ? (
                      <button
                        className="button primary small"
                        disabled={busy}
                        type="button"
                        onClick={() =>
                          onAction(
                            "publishGuide",
                            { guideId: guide.id },
                            "Guide shared",
                          )
                        }
                      >
                        Publish
                      </button>
                    ) : null}
                    {(guide.publishedRevision || guide.canArchive || guide.canDelete) ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          className="icon-button"
                          type="button"
                          aria-label={`More actions for ${revision?.title ?? guide.title}`}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                          {guide.publishedRevision ? (
                            <DropdownMenuItem onClick={() => onExport(guide)}>
                              <Download /> Export
                            </DropdownMenuItem>
                          ) : null}
                          {guide.canArchive && guide.status !== "archived" ? (
                            <DropdownMenuItem
                              disabled={busy}
                              onClick={() => void onAction("archiveGuide", { guideId: guide.id }, "Guide archived")}
                            >
                              <Archive /> Archive
                            </DropdownMenuItem>
                          ) : null}
                          {guide.canDelete ? (
                            <DropdownMenuItem
                              className="danger-menu-item"
                              disabled={busy}
                              onClick={() => setDeleteTarget(guide)}
                            >
                              <Trash2 /> Delete
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={guides.length ? Search : BookOpen}
            title={
              query.trim()
                ? "No matching guides"
                : libraryTab === "shared"
                  ? "No shared guides yet"
                  : "No drafts yet"
            }
            description={
              query.trim()
                ? "Try another search."
                : libraryTab === "shared"
                  ? "Published guides will appear here for the workspace."
                  : "Create a guide or capture a workflow to start a draft."
            }
            action={
              libraryTab === "drafts" && !query.trim() && canCreate ? (
                <Button onClick={onNew}>
                  <Plus /> Create guide
                </Button>
              ) : undefined
            }
          />
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
      {deleteTarget ? (
        <GuideDeleteDialog
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
      {confirmDialog}
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

function CaptureView({
  browserAvailable,
  desktopAvailable,
  browserPlanEnabled,
  desktopPlanEnabled,
  desktopDevices,
  typedTextPolicy,
  busy,
  onOpenExtension,
  onRevokeDesktopDevice,
  planLocked,
  onOpenPlan,
}: {
  browserAvailable: boolean;
  desktopAvailable: boolean;
  browserPlanEnabled: boolean;
  desktopPlanEnabled: boolean;
  desktopDevices: DesktopCaptureDevice[];
  typedTextPolicy: WorkspaceSettings["desktopTypedTextPolicy"];
  busy: boolean;
  onOpenExtension: () => void;
  onRevokeDesktopDevice: (deviceRecordId: string) => Promise<void>;
  planLocked: boolean;
  onOpenPlan?: () => void;
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
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Browser & Windows</p>
          <h1>Capture a workflow</h1>
          {planLocked ? (
            <>
              <p>
                Browser and Windows capture, Smart Blur, redact, and annotate
                are included on Pro.
                Free workspaces stay on typed guides so unblurred screenshots
                are never uploaded.
              </p>
              <p className="privacy-caption">
                Start a 14-day Pro trial to install a capture tool and redact
                locally before upload.
              </p>
              {onOpenPlan ? (
                <button className="button primary" type="button" onClick={onOpenPlan}>
                  View plans
                </button>
              ) : null}
            </>
          ) : (
            <>
              <p>
                Choose the recorder that matches the work. Both create an
                editable private draft in the same governed editor.
              </p>
              {!browserAvailable && !desktopAvailable ? (
                <p className="privacy-caption">
                  Capture is not enabled for your role in this workspace.
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
      {planLocked ? null : (
        <>
          <section className="capture-source-grid">
            <article className="card capture-source-card">
              <div className="capture-source-heading">
                <span><Globe2 /></span>
                <div>
                  <p className="eyebrow">Chrome & Edge</p>
                  <h2>Browser capture</h2>
                </div>
                <Badge variant="outline">Extension</Badge>
              </div>
              <p>
                Capture clicks and navigation inside a chosen browser scope,
                review every screenshot locally, then upload a private draft.
              </p>
              <ul className="capture-source-points">
                <li><Check /> Host-scoped recording indicator</li>
                <li><Check /> Smart Blur before upload</li>
                <li><Check /> Chrome side-panel guide companion</li>
              </ul>
              <button
                className="button primary"
                type="button"
                disabled={busy || !browserAvailable}
                onClick={onOpenExtension}
              >
                <Link2 /> Connect browser extension
              </button>
              {!browserPlanEnabled ? (
                <small>Browser capture is not included on this plan.</small>
              ) : null}
            </article>

            <article className="card capture-source-card desktop-capture-card">
              <div className="capture-source-heading">
                <span><Laptop /></span>
                <div>
                  <p className="eyebrow">Windows 10 & 11</p>
                  <h2>Desktop capture</h2>
                </div>
                <Badge variant="outline">New</Badge>
              </div>
              <p>
                Record meaningful actions across Windows applications with a
                compact recorder, explicit target scope, and always-visible
                controls.
              </p>
              <ul className="capture-source-points">
                <li><Check /> App, window, monitor, or all displays</li>
                <li><Check /> Pause, retry, finish, and discard from the HUD</li>
                <li><Check /> Opens directly in the KnowHow web editor</li>
              </ul>
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
                <p className="privacy-caption">
                  Signed installers will appear here when the release channel
                  is configured.
                </p>
              )}
              {!desktopPlanEnabled ? (
                <small>Windows capture is not included on this plan.</small>
              ) : !desktopAvailable ? (
                <small>Your role cannot start captures in this workspace.</small>
              ) : null}
            </article>
          </section>

          {desktopPlanEnabled ? (
            <section className="card paired-desktop-devices">
              <div className="section-heading compact">
                <div>
                  <p className="eyebrow">Paired devices</p>
                  <h2>Windows capture devices</h2>
                  <p>
                    Exact non-password text is {typedTextPolicy === "allowed" ? "allowed when the author enables it" : "disabled by workspace policy"}.
                  </p>
                </div>
              </div>
              {desktopDevices.length ? (
                <div className="desktop-device-list">
                  {desktopDevices.map((device) => (
                    <div className="desktop-device-row" key={device.id}>
                      <span className="desktop-device-row-icon"><Laptop /></span>
                      <div>
                        <strong>{device.name}</strong>
                        <small>
                          {device.version} · {device.architecture.toUpperCase()} · Last used {device.lastUsedAt ? formatDate(device.lastUsedAt, true) : "never"}
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
                <p className="empty-inline">
                  No Windows devices are connected yet. Install the app and
                  approve its named-device request in your browser.
                </p>
              )}
            </section>
          ) : null}

      <section className="privacy-grid">
        {[
          {
            icon: LockKeyhole,
            title: "Always excluded",
            copy: "Passwords, clipboard contents, raw keys, secure Windows surfaces, private browsing, and password managers.",
          },
          {
            icon: Shield,
            title: "Local Smart Blur",
            copy: "Emails, selected form fields, configured number categories, and manual regions.",
          },
          {
            icon: Eye,
            title: "Human privacy gate",
            copy: "Desktop drafts stay private and cannot be shared, exported, or published until the author completes privacy review.",
          },
        ].map(({ icon: Icon, title, copy }) => (
          <article className="card privacy-card" key={title}>
            <Icon />
            <h3>{title}</h3>
            <p>{copy}</p>
          </article>
        ))}
      </section>
        </>
      )}
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
        <span className="directory-context-pill"><ShieldCheck /> Audience controls</span>
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
        <span className="directory-context-pill"><Shield /> Role-based access</span>
      </div>
      <section className="directory-summary-grid members-summary-grid" aria-label="Member summary">
        <article><span><Users /></span><div><strong>{members.length}</strong><small>Total members</small></div></article>
        <article><span><UserCheck /></span><div><strong>{activeMemberCount}</strong><small>Active members</small></div></article>
        <article><span><ShieldCheck /></span><div><strong>{adminCount}</strong><small>Administrators</small></div></article>
        <article><span><Mail /></span><div><strong>{activeInvitationCount}</strong><small>Pending invitations</small></div></article>
      </section>
      <div className="access-guidance directory-guidance">
        <Shield />
        <div><strong>Access has two layers</strong><p>Roles control actions. Groups and direct audiences control which published guides each person receives.</p></div>
        <span>Vault access is assigned separately</span>
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
  const [vaultEnabled, setVaultEnabled] = useState(member.capabilities?.includes("vault") ?? false);
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
        <section className="role-picker capability-picker permission-section">
          <div className="permission-section-heading">
            <div><span className="field-label">Capabilities</span><small>Independent access outside workspace roles.</small></div>
          </div>
          <label className={`choice-row permission-option${vaultEnabled ? " selected" : ""}`}>
            <input type="checkbox" checked={vaultEnabled} onChange={(event) => setVaultEnabled(event.target.checked)} />
            <span><strong>Vault</strong><small>Access encrypted workspace credentials. This is independent of roles and guide audiences.</small></span>
          </label>
        </section>
        <PolicyNote icon={Shield} className="member-access-note">
          This member belongs to {countPhrase(member.groupIds.length, "group")} and may also receive workspace-wide or direct guide audiences.
        </PolicyNote>
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
        <footer className="modal-footer">
          <span />
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="button"
            disabled={busy || roles.length === 0}
            onClick={() =>
              onSave(roles, vaultEnabled ? ["vault"] : [])
            }
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
                  Roles are additive. Administrator and Vault access are assigned after membership.
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
  tickets,
  busy,
  canCreate,
  onCreate,
  onReply,
  onClose,
}: {
  tickets: SupportTicket[];
  busy: boolean;
  canCreate: boolean;
  onCreate: (subject: string, message: string) => Promise<void>;
  onReply: (ticketId: string, message: string) => Promise<void>;
  onClose: (ticketId: string) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState(tickets[0]?.id ?? "");
  const [creating, setCreating] = useState(false);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
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
          <span className="support-response-pill"><CheckCircle2 /> One-business-day target</span>
          {canCreate ? (
            <button className="button primary" type="button" disabled={busy || creating} onClick={() => setCreating(true)}>
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
                await onCreate(subject.trim(), message.trim());
                setSubject("");
                setMessage("");
                setCreating(false);
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
                <div><strong>Keep sensitive data out</strong><p>Don’t include guide content, screenshots, credentials, secrets, payment information, health data, or national IDs.</p></div>
                <span>No attachments</span>
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
                  minLength={10}
                  maxLength={4000}
                  rows={8}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Tell us what happened, what you tried, and the outcome you expected."
                />
              </label>
              </div>
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
                    <span>{selected.status === "resolved" ? "Still need help? Reply to reopen" : "Reply"}</span>
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
  const [section, setSection] = useState<"general" | "branding" | "publishing" | "exports">("general");
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
  const settingsSections = [
    {
      id: "general" as const,
      label: "General",
      description: "Privacy and capture safeguards",
      icon: Settings,
      status: "3 enforced",
    },
    {
      id: "branding" as const,
      label: "Branding",
      description: "Logo, colors, and exports",
      icon: Paintbrush,
      status: settings.logoUrl ? "Logo added" : "Logo needed",
    },
    {
      id: "publishing" as const,
      label: "Publishing",
      description: "Reviews and approvals",
      icon: ShieldCheck,
      status: settings.requireReviewBeforePublish ? "Review required" : "Direct publish",
    },
    {
      id: "exports" as const,
      label: "Exports",
      description: "Downloads and watermarks",
      icon: FileDown,
      status: settings.allowRestrictedExports ? "Restricted allowed" : "Restricted blocked",
    },
  ];
  const activeSection = settingsSections.find((item) => item.id === section)!;
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
        <span className="settings-workspace-pill">
          <ShieldCheck /> Workspace controls
        </span>
      </div>
      <div className="settings-console">
        <aside className="settings-section-nav" aria-label="Workspace settings sections">
          <div className="settings-nav-heading">
            <span>Workspace</span>
            <small>4 sections</small>
          </div>
          <div className="settings-tabs" role="tablist" aria-orientation="vertical">
            {settingsSections.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={section === item.id}
                  aria-controls={`settings-panel-${item.id}`}
                  className={section === item.id ? "active" : ""}
                  onClick={() => setSection(item.id)}
                >
                  <span className="settings-nav-icon"><Icon /></span>
                  <span className="settings-nav-copy">
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                  <span className="settings-nav-status">{item.status}</span>
                  <ChevronRight className="settings-nav-chevron" />
                </button>
              );
            })}
          </div>
          <div className="settings-nav-note">
            <ShieldCheck />
            <span>
              <strong>Admin only</strong>
              <small>Changes apply workspace-wide.</small>
            </span>
          </div>
        </aside>

        <div className="settings-main">
          <header className="settings-section-header">
            <div>
              <p className="eyebrow">{activeSection.label} settings</p>
              <h2>{activeSection.description}</h2>
            </div>
            <span>{activeSection.status}</span>
          </header>
          <div
            className="settings-grid"
            id={`settings-panel-${section}`}
            role="tabpanel"
          >
        {section === "general" ? (
          <section className="card settings-card settings-section-wide">
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
              <PolicyNote icon={LockKeyhole}>Administrator status does not grant guide access or bypass required review.</PolicyNote>
              <PolicyNote icon={Archive}>Published revisions stay immutable; edits create a new working draft.</PolicyNote>
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
        ) : null}
        {section === "branding" ? (
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
              <strong>Remove KnowHow branding {!removeBrandingEnabled ? <Badge variant="outline">Pro</Badge> : null}</strong>
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
        ) : null}
        {section === "publishing" ? (
        <section className="card settings-card settings-section-wide">
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
        ) : null}
        {section === "exports" ? (
        <section className="card settings-card settings-section-wide">
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
        ) : null}
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
  const { askToConfirm, dialog: confirmDialog } = useConfirmDialog();
  const canManage = organization.roles.includes("owner");
  const activeOwnerCount = organization.members.filter(
    (member) => member.status === "active" && member.roles.includes("owner"),
  ).length;
  const editingMember = organization.members.find(
    (member) => member.id === editingMemberId,
  );
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
      <section className="card settings-card organization-identity-card">
        <div className="settings-title">
          <span style={{ background: organization.branding.accentColor }}>
            <Building2 />
          </span>
          <div>
            <h2>{organization.legalName || organization.displayName}</h2>
            <div className="organization-metadata">
              <span><small>Legal name</small><strong>{organization.legalName || "Not provided"}</strong></span>
              <span><small>Country</small><strong>{organization.country}</strong></span>
              <span><small>Status</small><strong>{titleCase(organization.status)}</strong></span>
              <span><small>Your roles</small><strong>{organization.roles.map(organizationRoleLabel).join(", ")}</strong></span>
            </div>
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
            <div className="member-row" key={member.id}>
              <span className="avatar">
                {initials(member.name, member.email)}
              </span>
              <span className="member-main">
                <strong>{member.name || member.email}</strong>
                <small>{member.email}</small>
                <span className="role-chips">
                  {member.roles.map((role) => (
                    <span key={role}>{organizationRoleLabel(role)}</span>
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
  const vaultItems = active.vaultItems ?? [];
  const pendingSupportCount = supportRequests.filter(
    (item) => item.status === "pending",
  ).length;
  const [dialog, setDialog] = useState<DialogState>(null);
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
    storageBytes: 1_000_000_000,
    extensionEnabled: false,
    desktopCaptureEnabled: false,
    supportEnabled: false,
    removeBranding: false,
    privacyToolsEnabled: false,
    customSubdomainEnabled: false,
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
  const canCreateSupportTicket =
    canOpenSupport &&
    !busy &&
    (isAdmin || roles.includes("creator"));
  const currentMember = members.find(
    (member) => member.userId === data.viewer.id,
  );
  const canUseVault = currentMember?.capabilities?.includes("vault") ?? false;
  const organization = data.organizations?.find(
    (item) => item.id === workspace.organizationId,
  );
  const requestedView: View =
    route.kind === "workspace-section"
      ? SECTION_TO_VIEW[route.section]
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

  function openShareGuide(guide: Guide) {
    const revision = guide.workingRevision ?? guide.publishedRevision;
    const current = revision?.audiences ?? [];
    setShareDraft({
      audiences: current,
      privacyReviewed: Boolean(revision?.privacyReviewedAt),
    });
    setDialog({ type: "share-guide", guide });
  }

  function openExportGuide(guide: Guide) {
    setDialog({ type: "export-guide", guide });
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
    !(view === "Vault" && !canUseVault) &&
    !(["Groups", "Members", "Settings"].includes(view) && !isAdmin) &&
    !(view === "Organization" && !organization);
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
    routeGuideAuthor === data.viewer.id &&
    (isAdmin || roles.includes("creator")),
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
      if (item.view === "Capture") return canCapture;
      if (item.view === "Support") return canOpenSupport;
      if (["Groups", "Members", "Settings"].includes(item.view)) return isAdmin;
      return true;
    });
  const workspaceNavigation = visibleNav.filter(({ view: item }) =>
    ["Overview", "Guides", "Capture"].includes(item),
  );
  const peopleNavigation = visibleNav.filter(({ view: item }) =>
    ["Groups", "Members"].includes(item),
  );
  const governanceNavigation = visibleNav.filter(
    ({ view: item }) => item === "Settings",
  );
  const supportNavigation = visibleNav.filter(({ view: item }) => item === "Support");
  const onboardingAudience = isAdmin || canAnyCapture;
  const onboardingRemaining = active.onboarding.steps.filter(
    (step) => !step.completed,
  ).length;
  const onboardingPercent = Math.round(
    ((active.onboarding.steps.length - onboardingRemaining) /
      Math.max(1, active.onboarding.steps.length)) *
      100,
  );
  const showSetupNav =
    onboardingAudience && !active.onboarding.completedAt;
  const accessLabel = workspaceAccessLabel(roles);

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
  const sharingGuide = dialog?.type === "share-guide" ? dialog.guide : null;
  const exportingGuide = dialog?.type === "export-guide" ? dialog.guide : null;
  const shareDialog =
    sharingGuide && shareDraft ? (
      <GuideShareDialog
        open
        title={
          sharingGuide.workingRevision?.title ??
          sharingGuide.publishedRevision?.title ??
          sharingGuide.title
        }
        workspaceName={workspace.name}
        liveUrl={
          sharingGuide.publishedRevision
            ? `${window.location.origin}${guideHref(workspace.slug, sharingGuide.id, "published")}`
            : ""
        }
        isLive={Boolean(sharingGuide.publishedRevision)}
        audiences={shareDraft.audiences}
        groups={groups}
        members={members}
        captured={
          isCapturedGuideSource(
            (sharingGuide.workingRevision ?? sharingGuide.publishedRevision)
              ?.source,
          )
        }
        privacyReviewed={shareDraft.privacyReviewed}
        canShare={sharingGuide.canShare}
        canRequestReview={Boolean(
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
          await command(
            "shareGuide",
            {
              guideId: sharingGuide.id,
              audiences: shareDraft.audiences,
              privacyReviewed: shareDraft.privacyReviewed,
            },
            `${sharingGuide.publishedRevision ? "Audience updated" : "Guide published"} — ${audienceSuccessMessage(shareDraft.audiences)}`,
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
      title={
        exportingGuide.workingRevision?.title ??
        exportingGuide.publishedRevision?.title ??
        exportingGuide.title
      }
      isLive={Boolean(exportingGuide.publishedRevision)}
      restricted={Boolean(
        exportingGuide.publishedRevision &&
          !exportingGuide.publishedRevision.audiences.some((audience) => audience.kind === "workspace"),
      )}
      fileExportsEnabled={entitlements.fileExportsEnabled}
      canExport={Boolean(
        exportingGuide.publishedRevision &&
          (exportingGuide.publishedRevision.audiences.some((audience) => audience.kind === "workspace") ||
            workspace.settings.allowRestrictedExports),
      )}
      busy={busy || !workspaceMutable}
      onClose={() => setDialog(null)}
      onExport={async (format: GuideExportFormatChoice) => {
        await downloadAuthorizedExport(workspace.id, exportingGuide.id, format);
        toast.success("Export ready");
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
              ? `${typeof window === "undefined" ? "" : window.location.origin}${guideHref(workspace.slug, editorGuide.id, "published")}`
              : ""
          }
          fileExportsEnabled={entitlements.fileExportsEnabled}
          canExport={
            Boolean(editorGuide?.publishedRevision) &&
            (!publishedRestricted || workspace.settings.allowRestrictedExports)
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
          onShare={() => openShareGuide(routeGuide)}
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
        {shareDialog}
        {exportDialog}
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
                        <span className="workspace-menu-title">
                          <strong>{workspace.name}</strong>
                          <span className="workspace-plan-chip">
                            {workspacePlanLabel(workspace.subscription)}
                          </span>
                        </span>
                        <small>{workspaceAccessLabel(roles)}</small>
                      </span>
                    </>
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
                            type="button"
                            onClick={() => navigateToView("Overview")}
                          >
                            <ClipboardCheck />
                            <span>Getting started</span>
                          </SidebarMenuButton>
                          <SidebarMenuBadge>{onboardingPercent}%</SidebarMenuBadge>
                        </SidebarMenuItem>
                      ) : null}
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
                            <SidebarMenuButton isActive={view === item} type="button" onClick={() => navigateToView(item)}>
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
                {supportNavigation.length ? (
                  <SidebarGroup className="workspace-nav-group support-nav-group">
                    <nav className="main-nav" aria-label="Help navigation">
                      <SidebarMenu>
                        {supportNavigation.map(({ view: item, icon: Icon }) => (
                          <SidebarMenuItem key={item}>
                            <SidebarMenuButton isActive={view === item} type="button" onClick={() => navigateToView(item)}>
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
              <strong className="topbar-page-title">{NAV_LABELS[view]}</strong>
            </div>
            <div className="topbar-search-slot">
              {guides.length &&
                !["Organization", "Settings", "Support", "Administration"].includes(view) ? (
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
                captureLockedByPlan={
                  !entitlements.extensionEnabled &&
                  !entitlements.desktopCaptureEnabled
                }
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
                onNew={() => onNavigate(newGuideHref(workspace.slug))}
                onOpen={(guide) => openGuide(guide)}
                onEdit={(guide) =>
                  onNavigate(guideEditorHref(workspace.slug, guide.id))
                }
                onShare={openShareGuide}
                onExport={openExportGuide}
                onAction={command}
                busy={busy || !workspaceMutable}
              />
            ) : null}
            {view === "Capture" ? (
              <CaptureView
                browserAvailable={canCapture}
                desktopAvailable={canDesktopCapture}
                browserPlanEnabled={entitlements.extensionEnabled}
                desktopPlanEnabled={entitlements.desktopCaptureEnabled}
                desktopDevices={active.desktopCaptureDevices ?? []}
                typedTextPolicy={workspace.settings.desktopTypedTextPolicy}
                busy={busy || !workspaceMutable}
                onOpenExtension={() => setDialog({ type: "extension" })}
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
                planLocked={
                  !entitlements.extensionEnabled &&
                  !entitlements.desktopCaptureEnabled
                }
                onOpenPlan={
                  isAdmin ? () => setDialog({ type: "plan" }) : undefined
                }
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
            {view === "Vault" && canUseVault ? (
              <VaultView
                items={vaultItems}
                busy={busy || !workspaceMutable}
                onNew={() => setDialog({ type: "vault-editor", item: null })}
                onEdit={(item) => setDialog({ type: "vault-editor", item })}
                onReveal={(item) => setDialog({ type: "vault-reveal", item })}
                onDelete={(item) => {
                  void (async () => {
                    if (
                      !(await askToConfirm({
                        title: "Delete vault item?",
                        description: `Delete ${item.title}? This encrypted item cannot be recovered.`,
                        confirmLabel: "Delete",
                        tone: "danger",
                      }))
                    )
                      return;
                    await command(
                      "deleteVaultItem",
                      { vaultItemId: item.id },
                      "Vault item deleted",
                    ).catch(() => undefined);
                  })();
                }}
              />
            ) : null}
            {view === "Support" ? (
              canOpenSupport ? (
              <SupportView
                tickets={supportTickets}
                busy={busy || !workspaceMutable}
                canCreate={canCreateSupportTicket && workspaceMutable}
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
              <AdministrationView viewer={data.viewer} />
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
        {dialog?.type === "plan" && isAdmin ? (
          <PlanDialog
            subscription={workspace.subscription}
            entitlements={entitlements}
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

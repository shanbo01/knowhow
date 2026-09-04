"use client";

import {
  ArrowRight,
  Bell,
  BookOpen,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Copy,
  Download,
  FileDown,
  Globe2,
  Group,
  ImagePlus,
  KeyRound,
  LayoutDashboard,
  Laptop,
  LifeBuoy,
  Link2,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Mail,
  Moon,
  Paintbrush,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Trash2,
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
  uploadWorkspaceLogo,
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
  GuideSearchResult,
  SupportAccessRequest,
  SupportTicket,
  WorkspaceGroup,
  WorkspaceMember,
  WorkspaceSettings,
} from "../../lib/knowhow-types";
import {
  audienceSuccessMessage,
  BRANDED_PLANS,
  countPhrase,
  entitlementFromError,
  formatBytes,
  formatDate,
  initials,
  listPhrase,
  liveGuideUrl,
  messageFromError,
  titleCase,
  workspaceAccessLabel,
  workspacePlanLabel,
} from "./workspace/formatting";
import {
  DashboardProgress,
  EmptyState,
  Modal,
  PlanDialog,
  StatusBadge,
} from "./workspace/primitives";
import { GuidesView, GuideViewer } from "./workspace/library";
import {
  GroupDialog,
  GroupsView,
  InviteDialog,
  MemberDialog,
  MembersView,
  SupportDecisionDialog,
} from "./workspace/people";
import {
  OrganizationView,
} from "./workspace/organization";
import {
} from "../../lib/workspace-access-tiers";
import {
  guideEditorHref,
  guideHref,
  newGuideHref,
  administrationClientHref,
  workspaceHref,
  type AppRoute,
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
} from "@/components/ui/sheet";
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

// The per-role descriptions that used to live here are gone with the checkbox
// grid that showed them. One of them — "does not grant guide access" on
// administrator — had been false for as long as policy.ts had granted that
// role guide.create, guide.update and guide.publish. Access levels describe
// themselves once, in workspace-access-tiers.ts, so there is no second copy to
// drift from what the engine actually decides.

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
  const administratorNames = data.members
    .filter(
      (member) =>
        member.status === "active" && member.roles.includes("administrator"),
    )
    .map((member) => member.name?.trim() || member.email)
    .slice(0, 3);

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
        !canCreate && !canManageAccess ? (
          // Read-only members reach an empty library with no command they are
          // allowed to run. Telling them to write a guide under an action row
          // that renders nothing reads as a broken page, so say what is
          // actually missing and who can grant it.
          <section className="first-run-panel">
            <div>
              <p className="eyebrow">Nothing shared yet</p>
              <h2>Your access is read-only for now.</h2>
              <p>
                Guides appear here once someone shares one with you. To record
                or write your own, ask{" "}
                {administratorNames.length
                  ? `${listPhrase(administratorNames)} for Creator access.`
                  : "a workspace administrator for Creator access."}{" "}
                <a href="/help" target="_blank" rel="noreferrer">
                  How KnowHow works
                </a>{" "}
                explains what the levels mean.
              </p>
            </div>
          </section>
        ) : data.onboarding.completedAt || !(canManageAccess || canCapture) ? (
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
  reviewerCount,
  onSave,
  onRefresh,
  onRegisterNavigationGuard,
}: {
  workspaceId: string;
  workspaceName: string;
  initial: WorkspaceSettings;
  busy: boolean;
  removeBrandingEnabled: boolean;
  reviewerCount: number;
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
              // Turning this on without a reviewer stops the workspace
              // publishing anything at all: drafts can only move to review, and
              // a review only a reviewer can decide. Switching it back off is
              // always allowed.
              disabled={
                !settings.requireReviewBeforePublish && reviewerCount === 0
              }
              onChange={(event) =>
                update("requireReviewBeforePublish", event.target.checked)
              }
            />
            <span className="settings-switch" aria-hidden="true" />
          </label>
          {reviewerCount === 0 ? (
            <PolicyNote icon={LockKeyhole}>
              Nobody holds the Reviewer role yet. Give someone that role in
              People &amp; access first, or drafts submitted for review will have
              nobody to approve them.
            </PolicyNote>
          ) : (
            <PolicyNote icon={LockKeyhole}>Administrators cannot bypass required review.</PolicyNote>
          )}
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

// The four organization roles this table described are gone from the
// interface. Only one line was ever enforced — owners appoint people and
// change access, everyone else with organization access manages the
// directory — so ORGANIZATION_TIERS states that line, and billing and
// security auditor stopped being names a customer has to learn.

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
                {/*
                  Not gated on support access or remaining setup steps: the
                  help link belongs to everyone, and a member with neither is
                  the one most likely to need it.
                */}
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
                        {/*
                          Reachable by everyone, including a read-only member
                          with nothing shared with them yet — who is exactly the
                          person most likely to be wondering what this is.
                        */}
                        <SidebarMenuItem>
                          <SidebarMenuButton
                            tooltip="How KnowHow works"
                            type="button"
                            onClick={() =>
                              window.open("/help", "_blank", "noopener,noreferrer")
                            }
                          >
                            <BookOpen /><span>How KnowHow works</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      </SidebarMenu>
                    </nav>
                </SidebarGroup>
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
                deletedGuides={active.deletedGuides ?? []}
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
                onResend={(invitationId) => {
                  void command(
                    "resendInvite",
                    { invitationId },
                    "Invitation queued again",
                  ).catch(() => undefined);
                }}
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
                reviewerCount={
                  members.filter(
                    (item) =>
                      item.status === "active" &&
                      item.roles.includes("reviewer"),
                  ).length
                }
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
            isPlatformOwner={Boolean(dialog.member.platformProtected)}
            isLastAdministrator={
              dialog.member.status === "active" &&
              dialog.member.roles.includes("administrator") &&
              members.filter(
                (item) =>
                  item.status === "active" &&
                  item.roles.includes("administrator"),
              ).length <= 1
            }
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

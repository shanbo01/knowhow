"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Mail,
  Moon,
  Search,
  Shield,
  Sparkles,
  Sun,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { knowhowCommand, queryPlatform } from "../../../lib/knowhow-client";
import type {
  AdminAppointment,
  BootstrapResponse,
  PlatformDeletionCase,
  PlatformPricingCatalog,
  Viewer,
} from "../../../lib/knowhow-types";
import {
  platformCanonicalPath,
  platformHref,
  workspaceHref,
  type AppRoute,
  type PlatformSection,
} from "../../../lib/workspace-routes";
import { useConfirmDialog } from "../confirm-dialog";
import {
  AssignAdminDialog,
  PlatformProvisioningDialog,
  PricingCatalogDialog,
  SupportRequestDialog,
} from "../knowhow-workspace-app";
import { ProductBrand } from "../product-brand";
import { useTheme } from "../theme-provider";
import { DeletionApprovalDialog } from "./platform-dialogs";
import { initials, messageFromError, titleCase } from "./platform-format";
import {
  PlatformCustomersView,
  PlatformHomeView,
  PlatformLeadsView,
  PlatformSupportView,
  PlatformToolsView,
  sectionTitle,
} from "./platform-views";

const PLATFORM_NAV: Array<{
  section: PlatformSection;
  label: string;
  icon: typeof LayoutDashboard;
}> = [
  { section: "overview", label: "Home", icon: LayoutDashboard },
  { section: "customers", label: "Customers", icon: Building2 },
  { section: "leads", label: "Leads", icon: Mail },
  { section: "support", label: "Support", icon: LifeBuoy },
  { section: "tools", label: "Tools", icon: Wrench },
];

function PlatformGlobalSearch({
  onNavigate,
}: {
  onNavigate: (href: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<
    Array<{
      key: string;
      label: string;
      description: string;
      href: string;
      kind: string;
    }>
  >([]);
  const box = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const phrase = query.trim();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void queryPlatform<{
        results: Array<{
          kind: string;
          id: string;
          label: string;
          description: string;
          href: string;
        }>;
      }>({ resource: "search", q: phrase })
        .then((payload) => {
          if (cancelled) return;
          setResults(
            payload.results.map((item) => ({
              key: `${item.kind}:${item.id}`,
              label: item.label,
              description: item.description,
              href: item.href,
              kind: titleCase(item.kind),
            })),
          );
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

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
    <div className="global-search" ref={box}>
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
          placeholder="Search customers, leads, tickets, or emails"
          aria-label="Search the operator console"
        />
      </label>
      {open ? (
        <div
          className="search-results"
          role="listbox"
          aria-label="Platform search results"
        >
          <p className="search-result-count">
            {query.trim() ? "Best matches" : "Jump to a section"}
          </p>
          {results.length ? (
            results.map((result) => (
              <button
                className="search-result"
                type="button"
                key={result.key}
                onClick={() => openResult(result.href)}
              >
                <span className="guide-icon">
                  <Search />
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
            ))
          ) : (
            <p className="search-empty">
              No customers, leads, or tickets match &ldquo;{query.trim()}&rdquo;.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function PlatformApp({
  viewer,
  platform,
  route,
  activeWorkspaceSlug,
  onNavigate,
  onRefresh,
  onSignOut,
}: {
  viewer: Viewer;
  platform: NonNullable<BootstrapResponse["platform"]>;
  route: Extract<AppRoute, { kind: "platform" }>;
  activeWorkspaceSlug?: string;
  onNavigate: (href: string, options?: { replace?: boolean }) => void;
  onRefresh: () => Promise<unknown>;
  onSignOut: () => Promise<void>;
}) {
  const roles = viewer.platformRoles ?? [];
  const canManage = roles.some((role) => ["owner", "operations"].includes(role));
  const canSupport = canManage || roles.includes("support");
  const isOwner = roles.includes("owner");
  const { resolvedTheme, setPreference } = useTheme();
  const { askToConfirm, dialog: confirmDialog } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [provisioning, setProvisioning] = useState<{
    open: boolean;
    runId?: string;
  }>({ open: false });
  const [assigning, setAssigning] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [requesting, setRequesting] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deletion, setDeletion] = useState<PlatformDeletionCase | null>(null);
  const [catalog, setCatalog] = useState<PlatformPricingCatalog | "create" | null>(
    null,
  );

  useEffect(() => {
    const canonical = platformCanonicalPath(window.location.pathname);
    if (canonical) onNavigate(canonical, { replace: true });
  }, [route.section, route.entityId, onNavigate]);

  async function command<T>(action: string, payload: unknown, success: string) {
    setBusy(true);
    setError("");
    try {
      const result = await knowhowCommand<T>(
        action,
        (payload ?? {}) as Record<string, unknown>,
      );
      await onRefresh();
      if (success) toast.success(success);
      return result;
    } catch (nextError) {
      const message = messageFromError(nextError);
      setError(message);
      toast.error(message);
      throw nextError;
    } finally {
      setBusy(false);
    }
  }

  const counts: Partial<Record<PlatformSection, number>> = {
    leads: platform.queueCounts.newLeads,
    support: platform.queueCounts.openTickets,
    tools:
      platform.queueCounts.failedNotifications +
      platform.queueCounts.deletionApprovals,
  };

  return (
    <SidebarProvider>
      <div
        className="app-shell experience-shell"
        data-view="platform"
        data-access="platform"
      >
        <Sidebar className="sidebar" collapsible="offcanvas">
          <SidebarHeader className="workspace-sidebar-header">
            <div className="sidebar-brand">
              <ProductBrand compact />
            </div>
            <p className="sidebar-section-label">Operator console</p>
            <div className="workspace-menu">
              <span className="workspace-role-icon">
                <Shield />
              </span>
              <span className="workspace-menu-copy">
                <strong>KnowHow</strong>
                <small>Founder operator</small>
              </span>
            </div>
          </SidebarHeader>
          <SidebarContent>
            {activeWorkspaceSlug ? (
              <SidebarGroup className="workspace-nav-group">
                <nav className="main-nav" aria-label="Leave platform console">
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        type="button"
                        onClick={() =>
                          onNavigate(workspaceHref(activeWorkspaceSlug))
                        }
                      >
                        <ArrowLeft />
                        <span>Back to workspace</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </nav>
              </SidebarGroup>
            ) : null}
            <SidebarGroup className="workspace-nav-group">
              <p className="sidebar-section-label">Platform</p>
              <nav className="main-nav" aria-label="Platform navigation">
                <SidebarMenu>
                  {PLATFORM_NAV.map((item) => {
                    const Icon = item.icon;
                    return (
                      <SidebarMenuItem key={item.section}>
                        <SidebarMenuButton
                          isActive={route.section === item.section}
                          type="button"
                          onClick={() => onNavigate(platformHref(item.section))}
                        >
                          <Icon />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                        {counts[item.section] ? (
                          <SidebarMenuBadge>{counts[item.section]}</SidebarMenuBadge>
                        ) : null}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </nav>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <div className="app-main">
          <header className="topbar">
            <div className="topbar-start">
              <SidebarTrigger className="mobile-menu" />
              <div className="topbar-workspace">
                <span className="topbar-context-mark" aria-hidden="true">
                  <Shield />
                </span>
                <span className="topbar-context-copy">
                  <small>Operator console</small>
                  <strong>{sectionTitle(route.section, route.entityId)}</strong>
                </span>
              </div>
            </div>
            <div className="topbar-search-slot">
              <PlatformGlobalSearch onNavigate={onNavigate} />
            </div>
            <div className="topbar-actions">
              <Button
                className="theme-toggle"
                variant="outline"
                size="icon-sm"
                type="button"
                aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
                onClick={() => {
                  const theme = resolvedTheme === "dark" ? "light" : "dark";
                  window.localStorage.setItem(`knowhow-theme:${viewer.id}`, theme);
                  setPreference(theme);
                  void knowhowCommand("updateTheme", { theme }).catch(() => undefined);
                }}
              >
                {resolvedTheme === "dark" ? <Sun /> : <Moon />}
              </Button>
              {canManage ? (
                <Button
                  className="top-create topbar-primary-action"
                  size="sm"
                  type="button"
                  disabled={busy}
                  aria-label="Provision organization"
                  onClick={() => setProvisioning({ open: true })}
                >
                  <Building2 /> Provision organization
                </Button>
              ) : null}
              <Button
                className="profile-button"
                variant="outline"
                type="button"
                onClick={() => void onSignOut()}
              >
                <span className="avatar">{initials(viewer.name, viewer.email)}</span>
                <span>
                  <strong>{viewer.name}</strong>
                  <small>{viewer.email}</small>
                </span>
                <LogOut />
              </Button>
            </div>
          </header>
          {error ? (
            <div className="global-error" role="alert">
              <Sparkles />
              <span>{error}</span>
            </div>
          ) : null}
          <main className="workspace-main">
            {route.section === "overview" ? (
              <PlatformHomeView onNavigate={onNavigate} />
            ) : null}
            {route.section === "customers" ? (
              <PlatformCustomersView
                selectedId={route.entityId}
                canManage={canManage}
                canSupport={canSupport}
                busy={busy}
                onNavigate={onNavigate}
                onAssign={setAssigning}
                onRequestSupport={setRequesting}
                onStatus={(workspaceId, status) => {
                  const action =
                    status === "active"
                      ? "Restore"
                      : status === "suspended"
                        ? "Suspend"
                        : "Archive";
                  void (async () => {
                    if (
                      !(await askToConfirm({
                        title: `${action} this workspace?`,
                        description: `${action} this workspace?`,
                        confirmLabel: action,
                        tone: status === "active" ? "default" : "danger",
                      }))
                    )
                      return;
                    await command(
                      "setWorkspaceStatus",
                      { targetWorkspaceId: workspaceId, status },
                      `Workspace ${status}`,
                    ).catch(() => undefined);
                  })();
                }}
                onCommand={command}
              />
            ) : null}
            {route.section === "leads" ? (
              <PlatformLeadsView
                selectedId={route.entityId}
                canManage={canManage}
                busy={busy}
                onNavigate={onNavigate}
                onCommand={command}
                onProvision={(runId) => setProvisioning({ open: true, runId })}
              />
            ) : null}
            {route.section === "support" ? (
              <PlatformSupportView
                selectedId={route.entityId}
                canSupport={canSupport}
                busy={busy}
                onNavigate={onNavigate}
                onCommand={command}
              />
            ) : null}
            {route.section === "tools" ? (
              <PlatformToolsView
                canManage={canManage}
                isOwner={isOwner}
                busy={busy}
                catalogs={platform.pricingCatalogs ?? []}
                selfServiceLimit={platform.settings.selfServiceWorkspaceLimit}
                onCommand={command}
                onApproveDeletion={setDeletion}
                onOpenCatalog={setCatalog}
                onProvision={() => setProvisioning({ open: true })}
                onRevokeAppointment={(appointment: AdminAppointment) => {
                  void (async () => {
                    if (
                      !(await askToConfirm({
                        title: "Revoke appointment?",
                        description: `Revoke the administrator appointment for ${appointment.email}?`,
                        confirmLabel: "Revoke",
                      }))
                    )
                      return;
                    await command(
                      "revokeAppointment",
                      { appointmentId: appointment.id },
                      "Appointment revoked",
                    ).catch(() => undefined);
                  })();
                }}
              />
            ) : null}
          </main>
        </div>
        {provisioning.open ? (
          <PlatformProvisioningDialog
            busy={busy}
            initialRun={
              provisioning.runId
                ? platform.provisioningRuns.find((run) => run.id === provisioning.runId)
                : platform.provisioningRuns[0]
            }
            onClose={() => setProvisioning({ open: false })}
            onSave={(runId, step, stepData) =>
              command(
                "saveProvisioningRun",
                { ...(runId ? { runId } : {}), step, data: stepData },
                "",
              )
            }
            onComplete={(runId, finalStepData) =>
              command(
                "completeProvisioningRun",
                { runId, finalStepData },
                "Organization provisioned",
              )
            }
          />
        ) : null}
        {assigning ? (
          <AssignAdminDialog
            workspace={assigning}
            busy={busy}
            onClose={() => setAssigning(null)}
            onAssign={async (email) => {
              await command(
                "assignWorkspaceAdministrator",
                { targetWorkspaceId: assigning.id, email },
                "Workspace administrator assigned",
              );
              setAssigning(null);
            }}
          />
        ) : null}
        {requesting ? (
          <SupportRequestDialog
            workspace={requesting}
            busy={busy}
            onClose={() => setRequesting(null)}
            onRequest={async (requestedRole, reason, requestedDurationHours) => {
              await command(
                "requestSupportAccess",
                {
                  workspaceId: requesting.id,
                  requestedRole,
                  reason,
                  requestedDurationHours,
                },
                "Support access requested",
              );
              setRequesting(null);
            }}
          />
        ) : null}
        {deletion?.confirmationText ? (
          <DeletionApprovalDialog
            item={deletion}
            confirmationText={deletion.confirmationText}
            workspaceName={deletion.workspaceName}
            busy={busy}
            onClose={() => setDeletion(null)}
            onApprove={(caseId, confirmation) =>
              command(
                "approveDeletionCase",
                { caseId, confirmation },
                "Tenant purge approved",
              )
            }
          />
        ) : null}
        {catalog ? (
          <PricingCatalogDialog
            busy={busy}
            catalog={catalog === "create" ? null : catalog}
            generatedAt={platform.generatedAt}
            onClose={() => setCatalog(null)}
            onSave={async (current, input) => {
              if (current) {
                await command(
                  "updatePricingCatalog",
                  { catalogId: current.id, catalog: input },
                  "Pricing catalog saved",
                );
              } else {
                await command(
                  "createPricingCatalog",
                  { catalog: input },
                  "Pricing catalog created",
                );
              }
              setCatalog(null);
            }}
          />
        ) : null}
        {confirmDialog}
      </div>
    </SidebarProvider>
  );
}

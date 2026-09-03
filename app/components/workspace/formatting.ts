/**
 * Formatting, labelling and parsing shared across the workspace surfaces.
 *
 * Pulled out of the single component file these all used to live in, where a
 * fix applied to one dialog routinely missed its neighbour because the two
 * were nine thousand lines apart. Nothing here reaches for React or for a
 * view; it is the layer everything else in `workspace/` is allowed to import.
 */
import type {
  Audience,
  BootstrapResponse,
  Guide,
  OrganizationRole,
  WorkspaceRole,
} from "../../../lib/knowhow-types";
import { KnowHowApiError } from "../../../lib/knowhow-client";
import { guideHref } from "../../../lib/workspace-routes";

export function workspaceRoleLabel(role: WorkspaceRole) {
  if (role === "administrator") return "Administrator";
  return titleCase(role);
}

export function organizationRoleLabel(role: OrganizationRole) {
  if (role === "owner") return "Owner";
  if (role === "administrator") return "Administrator";
  return titleCase(role);
}

export function workspaceAccessLabel(roles: WorkspaceRole[]) {
  if (roles.includes("administrator")) return "Workspace administrator";

  const operationalRoles = (
    ["creator", "reviewer", "publisher"] as WorkspaceRole[]
  ).filter((role) => roles.includes(role));
  if (operationalRoles.length) {
    return operationalRoles.map(workspaceRoleLabel).join(" · ");
  }

  return "Viewer";
}

export function messageFromError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The operation could not be completed.";
}

export const ENTITLEMENT_COPY: Record<string, string> = {
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
export function entitlementFromError(error: unknown) {
  if (!(error instanceof KnowHowApiError)) return null;
  const kind = error.entitlement;
  if (!kind) return null;
  return { kind, message: ENTITLEMENT_COPY[kind] ?? error.message };
}

export function formatDate(value?: string, withTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" as const } : {}),
  }).format(date);
}

export function formatBytes(value: number) {
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
export function relativeDate(value?: string) {
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

export function initials(name: string, email = "") {
  const source = name.trim() || email;
  return source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function titleCase(value: string) {
  return value
    .replace(/[-_.]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function audienceSuccessMessage(audiences: Audience[]) {
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

export function liveGuideUrl(origin: string, workspaceSlug: string, guide: Guide) {
  const token = guide.publishedRevision?.audiences.find(
    (audience) => audience.kind === "link",
  )?.subjectId;
  return token
    ? `${origin}/share/${encodeURIComponent(token)}`
    : `${origin}${guideHref(workspaceSlug, guide.id, "published")}`;
}

export function countPhrase(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** "Ada", "Ada or Blake", "Ada, Blake or Kit" — for naming who to ask. */
export function listPhrase(items: string[], conjunction = "or") {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

export const INVITE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_BULK_INVITES = 50;

export function parseInviteEmails(value: string) {
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

export function workspaceOptionLabel(workspace: {
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
export const BRANDED_PLANS = new Set(["pro_trial", "pro", "enterprise"]);

export function planLabel(plan: string | undefined) {
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

export function workspacePlanLabel(
  subscription?: NonNullable<BootstrapResponse["activeWorkspace"]>["workspace"]["subscription"],
) {
  return planLabel(subscription?.plan);
}

export const PLAN_FEATURES: Array<{
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


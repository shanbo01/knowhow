export type WorkspaceSection =
  | "overview"
  | "guides"
  | "capture"
  | "groups"
  | "members"
  | "support"
  | "organization"
  | "vault"
  | "settings"
  | "administration";

export type GuideRevisionMode = "published" | "working";

export type AppRoute =
  | { kind: "root" }
  | { kind: "workspace-section"; workspaceSlug: string; section: WorkspaceSection }
  | { kind: "guide-new"; workspaceSlug: string }
  | { kind: "guide-view"; workspaceSlug: string; guideId: string; revision: GuideRevisionMode }
  | { kind: "guide-edit"; workspaceSlug: string; guideId: string }
  | { kind: "invalid" };

export type WorkspaceRoute = Exclude<AppRoute, { kind: "root" | "invalid" }>;

const WORKSPACE_SECTIONS: readonly WorkspaceSection[] = [
  "overview",
  "guides",
  "capture",
  "groups",
  "members",
  "support",
  "settings",
  "administration",
];

function safeSegment(value: string) {
  return encodeURIComponent(value);
}

function cleanPathname(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/";
}

function decodeSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isSafeRouteSegment(value: string | null): value is string {
  return typeof value === "string" && value.length > 0 && !/[\\/\0]/.test(value);
}

function isWorkspaceSection(value: string): value is WorkspaceSection {
  return WORKSPACE_SECTIONS.includes(value as WorkspaceSection);
}

export function workspaceHref(workspaceSlug: string, section: WorkspaceSection = "overview") {
  const base = `/w/${safeSegment(workspaceSlug)}`;
  return section === "overview" ? base : `${base}/${section}`;
}

export function newGuideHref(workspaceSlug: string) {
  return `${workspaceHref(workspaceSlug, "guides")}/new`;
}

export function guideHref(
  workspaceSlug: string,
  guideId: string,
  revision: GuideRevisionMode = "published",
) {
  return `${workspaceHref(workspaceSlug, "guides")}/${safeSegment(guideId)}?revision=${revision}`;
}

export function guideEditorHref(workspaceSlug: string, guideId: string) {
  return `${workspaceHref(workspaceSlug, "guides")}/${safeSegment(guideId)}/edit`;
}

export function routeWorkspaceSlug(route: AppRoute) {
  return "workspaceSlug" in route ? route.workspaceSlug : null;
}

export function parseAppRoute(pathname: string, search = ""): AppRoute {
  const normalizedPath = cleanPathname(pathname);
  if (normalizedPath === "/" || normalizedPath === "/app") return { kind: "root" };

  const rawSegments = normalizedPath.split("/").filter(Boolean);
  const segments = rawSegments.map(decodeSegment);
  if (!segments.every(isSafeRouteSegment)) return { kind: "invalid" };
  const [scope, ...rest] = segments as string[];

  if (scope !== "w" || !rest[0]) return { kind: "invalid" };
  const workspaceSlug = rest[0];
  const nested = rest.slice(1);

  if (nested.length === 0) {
    return { kind: "workspace-section", workspaceSlug, section: "overview" };
  }

  if (nested.length === 1 && isWorkspaceSection(nested[0])) {
    return { kind: "workspace-section", workspaceSlug, section: nested[0] };
  }

  if (nested[0] !== "guides") return { kind: "invalid" };
  if (nested.length === 2 && nested[1] === "new") {
    return { kind: "guide-new", workspaceSlug };
  }

  const guideId = nested[1];
  if (!guideId) return { kind: "invalid" };
  if (nested.length === 3 && nested[2] === "edit") {
    return { kind: "guide-edit", workspaceSlug, guideId };
  }
  if (nested.length === 2) {
    const revision = new URLSearchParams(search).get("revision") === "working"
      ? "working"
      : "published";
    return { kind: "guide-view", workspaceSlug, guideId, revision };
  }

  return { kind: "invalid" };
}

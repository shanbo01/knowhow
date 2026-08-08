import type {
  GuideSearchResult,
  WorkspaceMember,
  WorkspaceSettings,
} from "../knowhow-types";
import type { D1DatabaseLike } from "./d1";
import {
  evaluateGuideVisibility,
  type GuideRow,
  type RevisionAudienceRow,
  type RevisionMediaRow,
  type RevisionReviewRow,
  type RevisionRow,
  type RevisionStepRow,
} from "./guide-visibility";
import type { WorkspaceAccess } from "./repository";
import type { AuthenticatedIdentity } from "./appwrite-identity";

const MAX_TERMS = 5;
const MIN_TERM_LENGTH = 2;
const MAX_CANDIDATES = 200;

function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function splitSearchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= MIN_TERM_LENGTH),
    ),
  ].slice(0, MAX_TERMS);
}

function likeTerm(value: string) {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

async function loadSettingsForSearch(
  db: D1DatabaseLike,
  workspaceId: string,
): Promise<WorkspaceSettings> {
  const row = await db
    .prepare(
      `SELECT logo_object_key, accent_color, click_target_color, remove_branding,
              restricted_exports_enabled, watermark_restricted_exports, capture_policy_json
       FROM workspace_settings WHERE workspace_id = ?`,
    )
    .bind(workspaceId)
    .first<{
      logo_object_key: string | null;
      accent_color: string;
      click_target_color: string;
      remove_branding: number;
      restricted_exports_enabled: number;
      watermark_restricted_exports: number;
      capture_policy_json: string;
    }>();
  if (!row) {
    return {
      logoUrl: null,
      accentColor: "#356fe5",
      clickTargetColor: "#ef6f47",
      removeBranding: false,
      allowedDomains: [],
      excludedCaptureHosts: [],
      allowRestrictedExports: false,
      watermarkExports: true,
    };
  }
  const capture = safeJson<{ excludedHosts?: string[] }>(row.capture_policy_json, {});
  return {
    logoUrl: row.logo_object_key,
    accentColor: row.accent_color,
    clickTargetColor: row.click_target_color,
    removeBranding: row.remove_branding === 1,
    allowedDomains: [],
    excludedCaptureHosts: capture.excludedHosts ?? [],
    allowRestrictedExports: row.restricted_exports_enabled === 1,
    watermarkExports: row.watermark_restricted_exports === 1,
  };
}

async function loadMembersForSearch(
  db: D1DatabaseLike,
  workspaceId: string,
): Promise<WorkspaceMember[]> {
  const [memberRows, roleRows] = await Promise.all([
    db
      .prepare(
        `SELECT workspace_id, user_id, email, display_name, status, joined_at
         FROM workspace_members WHERE workspace_id = ? ORDER BY COALESCE(display_name, email)`,
      )
      .bind(workspaceId)
      .all<{
        workspace_id: string;
        user_id: string;
        email: string;
        display_name: string | null;
        status: "active" | "suspended";
        joined_at: string;
      }>(),
    db
      .prepare(`SELECT user_id, role FROM workspace_member_roles WHERE workspace_id = ?`)
      .bind(workspaceId)
      .all<{ user_id: string; role: WorkspaceMember["roles"][number] }>(),
  ]);
  return (memberRows.results ?? []).map((member) => ({
    id: `${member.workspace_id}:${member.user_id}`,
    userId: member.user_id,
    email: member.email,
    name: member.display_name ?? member.email,
    status: member.status,
    roles: (roleRows.results ?? [])
      .filter((item) => item.user_id === member.user_id)
      .map((item) => item.role),
    capabilities: [],
    groupIds: [],
    joinedAt: member.joined_at,
  }));
}

function excerptAround(
  display: { title: string; summary: string; category: string; tags: string[]; steps: Array<{ title: string; description: string }> },
  term: string,
): string {
  const fields = [
    display.summary,
    display.category,
    ...display.tags,
    ...display.steps.map((step) => `${step.title} ${step.description}`.trim()).filter(Boolean),
    display.title,
  ].filter(Boolean);
  const lower = term.toLowerCase();
  const hit = fields.find((field) => field.toLowerCase().includes(lower));
  if (!hit) {
    const fallback = display.summary || display.title;
    return fallback.slice(0, 160);
  }
  const index = hit.toLowerCase().indexOf(lower);
  const start = Math.max(0, index - 60);
  const end = Math.min(hit.length, index + term.length + 100);
  return `${start > 0 ? "…" : ""}${hit.slice(start, end).trim()}${end < hit.length ? "…" : ""}`;
}

export async function searchGuides(
  db: D1DatabaseLike,
  access: WorkspaceAccess,
  identity: AuthenticatedIdentity,
  isPlatformAdministrator: boolean,
  query: string,
): Promise<GuideSearchResult[]> {
  const terms = splitSearchTerms(query);
  if (terms.length === 0) return [];

  // Parameterized LIKE pre-filter across guide and revision metadata plus step
  // text. This only narrows candidates; final visibility is decided by the
  // same per-revision authorization used by the workspace guide list.
  const termGroups = terms.map(
    () => `(
       g.title LIKE ? ESCAPE '\\'
       OR r.title LIKE ? ESCAPE '\\'
       OR r.summary LIKE ? ESCAPE '\\'
       OR r.category LIKE ? ESCAPE '\\'
       OR r.tags_json LIKE ? ESCAPE '\\'
       OR r.system_references_json LIKE ? ESCAPE '\\'
       OR s.title LIKE ? ESCAPE '\\'
       OR s.body LIKE ? ESCAPE '\\'
     )`,
  );
  const termValues = terms.flatMap((term) => Array(8).fill(likeTerm(term)));
  const candidateResult = await db
    .prepare(
      `SELECT DISTINCT g.id
       FROM guides g
       JOIN guide_revisions r ON r.guide_id = g.id AND r.workspace_id = g.workspace_id
       LEFT JOIN guide_steps s ON s.revision_id = r.id
       WHERE g.workspace_id = ?
         AND ${termGroups.join(" AND ")}
       LIMIT ${MAX_CANDIDATES}`,
    )
    .bind(access.workspaceId, ...termValues)
    .all<{ id: string }>();
  const candidateIds = (candidateResult.results ?? []).map((item) => item.id);
  if (candidateIds.length === 0) return [];
  const candidateJson = JSON.stringify(candidateIds);

  const [settings, members, guideRowsResult] = await Promise.all([
    loadSettingsForSearch(db, access.workspaceId),
    loadMembersForSearch(db, access.workspaceId),
    db
      .prepare(
        `SELECT id, workspace_id, title, author_user_id, current_published_revision_id,
                working_draft_revision_id, archived_at, created_at, updated_at
         FROM guides
         WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))`,
      )
      .bind(access.workspaceId, candidateJson)
      .all<GuideRow>(),
  ]);
  const guideRows = guideRowsResult.results ?? [];

  const [revisionRows, stepRows, audienceRows, reviewRows, mediaRows] = await Promise.all([
    db
      .prepare(
        `SELECT r.id, r.guide_id, r.workspace_id, r.version, r.status, r.source_type,
                r.title, r.summary, r.category, r.tags_json, r.system_references_json,
                r.privacy_reviewed_at, r.created_by, r.created_at, r.updated_at,
                r.published_by, r.published_at,
                EXISTS (
                  SELECT 1 FROM capture_sessions c
                  WHERE c.workspace_id = r.workspace_id
                    AND c.status IN ('recording', 'paused')
                    AND json_extract(c.capture_scope, '$.revisionId') = r.id
                ) AS has_active_capture
         FROM guide_revisions r
         WHERE r.workspace_id = ? AND r.guide_id IN (SELECT value FROM json_each(?))
         ORDER BY r.guide_id, r.version DESC`,
      )
      .bind(access.workspaceId, candidateJson)
      .all<RevisionRow>(),
    db
      .prepare(
        `SELECT s.revision_id, s.id, s.position, s.kind, s.title, s.body, s.annotation_json
         FROM guide_steps s
         JOIN guide_revisions r ON r.id = s.revision_id
         WHERE r.workspace_id = ? AND r.guide_id IN (SELECT value FROM json_each(?))
         ORDER BY s.revision_id, s.position`,
      )
      .bind(access.workspaceId, candidateJson)
      .all<RevisionStepRow>(),
    db
      .prepare(
        `SELECT a.revision_id, a.subject_type, a.subject_id
         FROM guide_audiences a
         JOIN guide_revisions r ON r.id = a.revision_id
         WHERE r.workspace_id = ? AND r.guide_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(access.workspaceId, candidateJson)
      .all<RevisionAudienceRow>(),
    db
      .prepare(
        `SELECT a.revision_id, a.reviewer_user_id, a.status, a.decided_at
         FROM review_assignments a
         JOIN guide_revisions r ON r.id = a.revision_id
         WHERE r.workspace_id = ? AND r.guide_id IN (SELECT value FROM json_each(?))
         ORDER BY a.revision_id, a.decided_at`,
      )
      .bind(access.workspaceId, candidateJson)
      .all<RevisionReviewRow>(),
    db
      .prepare(
        `SELECT m.revision_id, m.id, m.step_id
         FROM guide_media m
         JOIN guide_revisions r ON r.id = m.revision_id
         WHERE r.workspace_id = ? AND r.guide_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(access.workspaceId, candidateJson)
      .all<RevisionMediaRow>(),
  ]);

  const revisions = revisionRows.results ?? [];
  const steps = stepRows.results ?? [];
  const audiences = audienceRows.results ?? [];
  const reviews = reviewRows.results ?? [];
  const media = mediaRows.results ?? [];
  const activeCaptureRevisionIds = new Set(
    revisions.filter((item) => item.has_active_capture === 1).map((item) => item.id),
  );
  const groupNames = new Map<string, string>();

  const results: GuideSearchResult[] = [];
  for (const guide of guideRows) {
    const visibility = evaluateGuideVisibility({
      guide,
      revisions: revisions.filter((item) => item.guide_id === guide.id),
      steps,
      audiences,
      reviews,
      media,
      activeCaptureRevisionIds,
      access,
      identity,
      isPlatformAdministrator,
      settings,
      members,
      groupNames,
    });
    if (!visibility) continue;
    const display = visibility.working ?? visibility.published;
    if (!display) continue;
    results.push({
      guideId: guide.id,
      revisionId: display.id,
      title: display.title,
      excerpt: excerptAround(display, terms[0]),
      status: visibility.status,
      restricted: visibility.restricted,
      updatedAt: guide.updated_at,
    });
  }
  return results;
}

import "server-only";

import type { GuideSearchResult } from "../knowhow-types";
import { AccessService } from "./access-service";
import { BootstrapService } from "./bootstrap-service";
import { HttpError } from "./http-security";
import { requireAuthorized } from "./policy";
import type { RecordStore } from "./record-store";
import type { AuthenticatedIdentity } from "./session-identity";

function searchTerms(query: string) {
  return [
    ...new Set(
      query
        .toLocaleLowerCase()
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    ),
  ].slice(0, 5);
}

function excerpt(text: string, terms: string[]) {
  const normalized = text.toLocaleLowerCase();
  const positions = terms
    .map((term) => normalized.indexOf(term))
    .filter((index) => index >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, first - 60);
  const value = text.replace(/\s+/g, " ").slice(start, start + 220).trim();
  return `${start > 0 ? "…" : ""}${value}${start + 220 < text.length ? "…" : ""}`;
}

export async function searchAuthorizedGuides(
  store: RecordStore,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  query: string,
): Promise<GuideSearchResult[]> {
  const terms = query.length <= 300 ? searchTerms(query) : [];
  if (!terms.length) {
    throw new HttpError(
      400,
      "SEARCH_QUERY_INVALID",
      "Use search terms of at least two characters.",
    );
  }
  const accessService = new AccessService(store);
  const access = await accessService.requireWorkspace(workspaceId, identity);
  requireAuthorized("workspace.read", accessService.context(access));
  const bootstrap = await new BootstrapService(store).bootstrap(
    identity,
    workspaceId,
  );
  return (bootstrap.activeWorkspace?.guides ?? [])
    .flatMap((guide) => {
      const revision = guide.workingRevision ?? guide.publishedRevision;
      if (!revision) return [];
      const searchable = [
        revision.title,
        revision.summary,
        revision.category,
        ...revision.tags,
        ...revision.systemReferences,
        ...revision.steps.flatMap((step) => [step.title, step.description]),
      ].join("\n");
      const normalized = searchable.toLocaleLowerCase();
      if (!terms.every((term) => normalized.includes(term))) return [];
      return [
        {
          guideId: guide.id,
          revisionId: revision.id,
          title: revision.title,
          excerpt: excerpt(searchable, terms),
          status: revision.status,
          restricted: guide.restricted,
          updatedAt: guide.updatedAt,
        } satisfies GuideSearchResult,
      ];
    })
    .slice(0, 50);
}

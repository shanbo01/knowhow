"use client";

/**
 * The guide library: the list, its filters and tabs, the preview sheet, and
 * the read-only viewer.
 *
 * Lifted whole out of the component file that held every workspace surface at
 * once. Nothing here changed in the move; it simply stopped sharing a file
 * with the settings page and the member dialogs.
 */
import { useState, type ReactNode } from "react";
import {
  Archive,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  FilterX,
  Globe2,
  Grid2X2,
  Link2,
  List,
  LockKeyhole,
  MoreHorizontal,
  PenLine,
  RotateCcw,
  Rows2,
  Rows3,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import type {
  DeletedGuide,
  Guide,
  GuideRevisionView,
} from "../../../lib/knowhow-types";
import { isCapturedGuideSource } from "../../../lib/guide-contracts";
import type { GuideRevisionMode } from "../../../lib/workspace-routes";
import { GuideDeleteDialog } from "../guide-delete-dialog";
import type { GuideExportFormatChoice } from "../guide-export-dialog";
import { GuideFavicon } from "../guide-favicon";
import { GuideReaderView } from "../guide-reader-view";
import { SelectMenu } from "../select-menu";
import { useConfirmDialog } from "../confirm-dialog";
import { EmptyState, ListPagination, StatusBadge } from "./primitives";
import {
  formatDate,
  relativeDate,
  titleCase,
} from "./formatting";

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

export function GuidesView({
  guides,
  deletedGuides,
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
  deletedGuides: DeletedGuide[];
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

  async function withdrawGuide(guide: Guide) {
    if (!guide.canUnsubmit) return;
    if (
      !(await askToConfirm({
        title: "Withdraw this guide from review?",
        description:
          "The guide becomes an editable draft again and the pending review is cancelled. Submit it again when it is ready.",
        confirmLabel: "Withdraw from review",
      }))
    )
      return;
    await onAction("unsubmitGuide", { guideId: guide.id }, "Guide withdrawn from review");
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
          {guide.canUnsubmit && guide.status === "review" ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={busy}
                onClick={() => void withdrawGuide(guide)}
              >
                <Undo2 /> Withdraw from review
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

      {/*
        Deletion used to be final: the guide, its revisions and its screenshots
        were marked and then unreachable, with no path back for the person who
        mis-clicked. It sits under Archived because that is where retired
        guides already live, and it is only ever populated for people who could
        restore what is in it.
      */}
      {tab === "archived" && deletedGuides.length ? (
        <section className="library-deleted">
          <div className="library-deleted-heading">
            <strong>Recently deleted</strong>
            <small>
              Restored guides come back archived, then any revision can be
              restored into a new draft.
            </small>
          </div>
          <ul className="library-deleted-list">
            {deletedGuides.map((entry) => (
              <li key={entry.id}>
                <span>
                  <strong>{entry.title}</strong>
                  <small>
                    Deleted {formatDate(entry.deletedAt, true)}
                    {entry.deletedByName ? ` by ${entry.deletedByName}` : ""}
                  </small>
                </span>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void onAction(
                      "undeleteGuide",
                      { guideId: entry.id },
                      `${entry.title} restored`,
                    )
                  }
                >
                  <Undo2 /> Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
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

export function GuideViewer({
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

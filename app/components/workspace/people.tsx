"use client";

/**
 * Members, groups, invitations, and the dialogs that change who has access.
 *
 * Access is chosen as one level per person rather than assembled from a set of
 * roles, so these screens ask a single question. Keeping them together is what
 * keeps the member dialog and the invitation dialog consistent with each other
 * — which they were not while they sat two thousand lines apart.
 */
import { useMemo, useState } from "react";
import {
  ArrowRight, BookOpen, Check, CheckCircle2, CircleAlert, Copy, Group, Link2,
  LoaderCircle, LockKeyhole, Mail, Plus, Search, Shield, ShieldCheck, Trash2,
  UserCheck, UserCog, Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  Invitation, SupportAccessGrant, SupportAccessRequest, WorkspaceGroup,
  WorkspaceMember, WorkspaceRole,
} from "../../../lib/knowhow-types";
import { WORKSPACE_ROLES } from "../../../lib/knowhow-types";
import {
  ACCESS_TIERS, ACCESS_TIER_LABELS, ACCESS_TIER_SUMMARIES, INVITABLE_TIERS,
  isCanonicalForTier, rolesForTier, tierForRoles,
  type AccessTier, type InvitableTier,
} from "../../../lib/workspace-access-tiers";
import { SelectMenu } from "../select-menu";
import { PolicyNote } from "../workspace-patterns";
import { useConfirmDialog } from "../confirm-dialog";
import { EmptyState, Modal, StatusBadge } from "./primitives";
import {
  countPhrase, formatDate, initials, MAX_BULK_INVITES,
  messageFromError, parseInviteEmails, titleCase, workspaceRoleLabel,
} from "./formatting";

export function GroupsView({
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

export function GroupDialog({
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

/**
 * What to say about an invitation's email, when there is anything to say.
 *
 * Silent on a delivered one: an invitation that worked needs no commentary. A
 * failure is the case worth naming, because it is otherwise indistinguishable
 * from an invitation sitting in somebody's spam folder.
 */
function deliveryNote(invite: Invitation) {
  switch (invite.delivery?.state) {
    case "failed":
      return "email could not be delivered";
    case "pending":
      return "email queued";
    default:
      return "";
  }
}

export function MembersView({
  members,
  invitations,
  supportRequests,
  supportGrants,
  busy,
  onEdit,
  onRevoke,
  onResend,
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
  onResend: (id: string) => void;
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
                    {deliveryNote(invite) ? ` · ${deliveryNote(invite)}` : ""}
                  </small>
                </span>
                <StatusBadge status={status} />
                {status === "active" && invite.delivery?.state === "failed" ? (
                  <button
                    className="button ghost small"
                    disabled={busy}
                    onClick={() => onResend(invite.id)}
                  >
                    <Mail /> Resend
                  </button>
                ) : null}
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

export function SupportDecisionDialog({
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

export function MemberDialog({
  member,
  isCurrentUser,
  isPlatformOwner,
  isLastAdministrator,
  busy,
  onClose,
  onSave,
  onSuspend,
}: {
  member: WorkspaceMember;
  isCurrentUser: boolean;
  isPlatformOwner: boolean;
  isLastAdministrator: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (roles: WorkspaceRole[]) => Promise<void>;
  onSuspend: () => Promise<void>;
}) {
  const [tier, setTier] = useState<AccessTier>(() => tierForRoles(member.roles));
  // Memberships written before the ladder existed can hold combinations no
  // level produces. They are shown at their nearest level, and named here so
  // an administrator is not surprised when saving rewrites them.
  const legacyRoles = isCanonicalForTier(member.roles)
    ? null
    : member.roles.map(workspaceRoleLabel).join(", ");
  // Refusals here are ordinary outcomes, not crashes: the last administrator
  // cannot be demoted, and a platform owner cannot be suspended. The shell's
  // error banner renders underneath this modal, so it has to be said in here.
  const [error, setError] = useState("");
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
            <div>
              <span className="field-label">Workspace access</span>
              <small>Each level includes everything below it.</small>
            </div>
          </div>
          {ACCESS_TIERS.map((option) => {
            // The command layer refuses to remove the workspace's only
            // administrator. Locking the choice says so while there is still
            // time to give someone else the role, instead of failing on save.
            const locked = isLastAdministrator && option !== "admin";
            return (
              <label
                className={`choice-row permission-option${tier === option ? " selected" : ""}${locked ? " is-locked" : ""}`}
                key={option}
              >
                <input
                  type="radio"
                  name="workspace-access-tier"
                  checked={tier === option}
                  disabled={locked}
                  onChange={() => setTier(option)}
                />
                <span>
                  <strong>{ACCESS_TIER_LABELS[option]}</strong>
                  <small>{ACCESS_TIER_SUMMARIES[option]}</small>
                </span>
              </label>
            );
          })}
          {isLastAdministrator ? (
            <PolicyNote icon={LockKeyhole}>
              The only administrator. Make someone else an Admin before
              changing this.
            </PolicyNote>
          ) : null}
          {legacyRoles ? (
            <PolicyNote icon={Shield}>
              This member holds an older combination of roles
              ({legacyRoles}). Saving will move them to the level shown above.
            </PolicyNote>
          ) : null}
        </section>
        <PolicyNote icon={Shield} className="member-access-note">
          This member belongs to {countPhrase(member.groupIds.length, "group")} and may also receive workspace-wide or direct guide audiences.
        </PolicyNote>
        {isCurrentUser || isPlatformOwner || isLastAdministrator ? (
          <PolicyNote icon={ShieldCheck} className="member-protected-note">
            {isPlatformOwner
              ? "This KnowHow owner account is protected from workspace suspension."
              : isLastAdministrator
                ? "The only administrator cannot be suspended. Give someone else that role first."
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
              setError("");
              void askToConfirm({
                title: member.status === "suspended" ? `Restore ${member.name || member.email}?` : `Suspend ${member.name || member.email}?`,
                description: member.status === "suspended" ? "Restore this member's workspace access?" : "They will lose workspace access immediately. Their guides and audit history remain.",
                confirmLabel: member.status === "suspended" ? "Restore member" : "Suspend member",
                tone: member.status === "suspended" ? "default" : "danger",
              }).then((confirmed) => {
                if (!confirmed) return;
                void onSuspend().catch((nextError) =>
                  setError(messageFromError(nextError)),
                );
              });
            }}
          >
            {member.status === "suspended" ? "Restore" : "Suspend"}
          </button>
          </section>
        )}
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
            type="button"
            disabled={busy}
            onClick={() => {
              setError("");
              void onSave(rolesForTier(tier)).catch((nextError) =>
                setError(messageFromError(nextError)),
              );
            }}
          >
            <Check /> Save
          </button>
        </footer>
      </div>
      {confirmDialog}
    </Modal>
  );
}

export function InviteDialog({
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
  const [tier, setTier] = useState<InvitableTier>("creator");
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
            // The three invitable levels share their names with the roles the
            // token already carries, so the wire format is unchanged and
            // outstanding invitations keep working. The server expands the
            // name into that level's full role set when it is redeemed.
            role: tier,
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
                  ? "Invitation created"
                  : `${created.length} invitations created`}
              </strong>
              <p>
                The email is queued and usually arrives within a few minutes;
                People &amp; access shows whether it did. Sending them this link
                works either way, and is the surer thing right now.
              </p>
            </div>
            <div className="created-invite-list">
              {created.map((item) => {
                const url = `${origin}/app?invite=${encodeURIComponent(item.token)}`;
                return (
                  <div className="copy-field" key={item.email}>
                    <span className="created-invite-email">{item.email}</span>
                    <input readOnly value={url} aria-label={`${item.email} invitation link`} />
                    {/*
                      Primary, not secondary. The link is the path that works
                      whatever the mail queue does, and it was styled as the
                      afterthought to an email the dialog had already claimed
                      to have sent.
                    */}
                    <button
                      className="button primary"
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
                <div><strong>What can they do?</strong><small>Each level includes everything below it, and can be changed later.</small></div>
              </div>
              <div className="field">
                <SelectMenu
                  className="form-select"
                  value={tier}
                  onChange={(value) => setTier(value as InvitableTier)}
                  ariaLabel="Invitation access"
                  options={INVITABLE_TIERS.map((option) => ({
                    value: option,
                    label: `${ACCESS_TIER_LABELS[option]} — ${ACCESS_TIER_SUMMARIES[option].replace(/^Also /, "").replace(/\.$/, "")}`,
                  }))}
                />
              </div>
              {/*
                Expiry and the internal label were asked before anyone had
                sent a single invitation. Both have defaults that are right
                almost always, and both are visible on the invitation
                afterwards, so they are settings rather than questions.
              */}
              <details className="invite-advanced">
                <summary>More options</summary>
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
              </details>
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


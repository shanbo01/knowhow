"use client";

/**
 * The organization surface: its details, its workspace directory, and who
 * holds authority over it.
 *
 * Organization access is two levels rather than four roles, on the same
 * footing as workspace access, so both dialogs here ask one question.
 */
import { useState } from "react";
import {
  Archive, ArchiveRestore, Building2, CheckCircle2, Copy, LoaderCircle,
  LockKeyhole, Mail, Pencil, Plus, Shield, ShieldCheck, UserCheck, UserCog,
  UserPlus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  OrganizationAdministration, OrganizationRole,
} from "../../../lib/knowhow-types";
import {
  isCanonicalForOrganizationTier, ORGANIZATION_TIERS,
  ORGANIZATION_TIER_LABELS, ORGANIZATION_TIER_SUMMARIES,
  organizationTierForRoles, rolesForOrganizationTier, type OrganizationTier,
} from "../../../lib/workspace-access-tiers";
import { SelectMenu } from "../select-menu";
import { PolicyNote } from "../workspace-patterns";
import { UsageMeter } from "../plan-usage";
import { useConfirmDialog } from "../confirm-dialog";
import { Modal, StatusBadge } from "./primitives";
import {
  countPhrase, formatDate, initials, MAX_BULK_INVITES, messageFromError,
  organizationRoleLabel, parseInviteEmails, planLabel, workspaceOptionLabel,
} from "./formatting";

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
          <div className="invite-row" key={workspace.id}>
            <span className="invite-icon">
              <Building2 />
            </span>
            {renamingWorkspaceId === workspace.id ? (
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
              renamingWorkspaceId === workspace.id ? (
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
                          // Not the danger tone: that dialog is headed
                          // "Permanent action", and archiving can be undone.
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

export function OrganizationWorkspaceDialog({
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

export function OrganizationAppointmentDialog({
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
  const [appointedTier, setAppointedTier] = useState<OrganizationTier>("administrator");
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
              !workspaceId
            ) {
              return;
            }
            setError("");
            try {
              const result = await onAppoint({
                emails: parsed.emails,
                roles: rolesForOrganizationTier(appointedTier),
                anchorWorkspaceId: workspaceId,
              });
              if (result.length) setCreated(result);
            } catch (nextError) {
              setError(messageFromError(nextError));
            }
          }}
        >
          <p className="modal-copy">
            Organization access covers the organization itself — its details,
            its workspace directory, and who else has access. Workspace access
            and guide audiences are set separately, on the Members page.
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
            {ORGANIZATION_TIERS.map((option) => (
              <label
                className={`choice-row permission-option${appointedTier === option ? " selected" : ""}`}
                key={option}
              >
                <input
                  type="radio"
                  name="appointed-organization-tier"
                  checked={appointedTier === option}
                  onChange={() => setAppointedTier(option)}
                />
                <span>
                  <strong>{ORGANIZATION_TIER_LABELS[option]}</strong>
                  <small>{ORGANIZATION_TIER_SUMMARIES[option]}</small>
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

export function OrganizationMemberDialog({
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
  const [tier, setTier] = useState<OrganizationTier>(() =>
    organizationTierForRoles(member.roles),
  );
  // Billing and security auditor are weaker than administrator, so a
  // membership holding one is shown at the administrator level but saving it
  // there grants more than it had. Say so before it happens.
  const legacyRoles = isCanonicalForOrganizationTier(member.roles)
    ? null
    : member.roles.map(organizationRoleLabel).join(", ");
  const [error, setError] = useState("");
  const { askToConfirm, dialog: confirmDialog } = useConfirmDialog();

  async function revoke() {
    setError("");
    const confirmed = await askToConfirm({
      title: `Revoke ${member.name || member.email}'s organization access?`,
      description:
        "Organization authority ends immediately. Their workspace membership and guides are not affected.",
      confirmLabel: "Revoke access",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await onSave(rolesForOrganizationTier(tier), "revoked");
    } catch (nextError) {
      setError(messageFromError(nextError));
    }
  }

  return (
    <Modal
      title={`Organization access · ${member.name || member.email}`}
      eyebrow="Owner-controlled authority"
      onClose={onClose}
    >
      <form
        className="modal-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            await onSave(rolesForOrganizationTier(tier), "active");
          } catch (nextError) {
            setError(messageFromError(nextError));
          }
        }}
      >
        <p className="modal-copy">
          This is authority over the organization — its details, its workspace
          directory, and who else has access. It never changes the
          person&apos;s workspace membership or which guides they can read. An
          organization always keeps at least one owner; appoint a second so
          nobody is ever locked out.
        </p>
        <div className="role-picker">
          {ORGANIZATION_TIERS.map((option) => (
            <label
              className={`choice-row permission-option${tier === option ? " selected" : ""}`}
              key={option}
            >
              <input
                type="radio"
                name="organization-tier"
                checked={tier === option}
                onChange={() => setTier(option)}
              />
              <span>
                <strong>{ORGANIZATION_TIER_LABELS[option]}</strong>
                <small>{ORGANIZATION_TIER_SUMMARIES[option]}</small>
              </span>
            </label>
          ))}
        </div>
        {legacyRoles ? (
          <PolicyNote icon={Shield}>
            This person holds an older set of organization roles
            ({legacyRoles}). Saving will move them to the level above, which
            grants more than they have today.
          </PolicyNote>
        ) : null}
        {member.status === "active" ? (
          <section className="member-danger-zone">
            <div>
              <strong>Revoke organization access</strong>
              <small>
                Takes effect immediately. Their workspace membership and guides
                are untouched.
              </small>
            </div>
            <button
              className="button danger-button"
              type="button"
              disabled={busy}
              onClick={() => void revoke()}
            >
              Revoke
            </button>
          </section>
        ) : (
          <PolicyNote icon={ShieldCheck}>
            Organization access is revoked. Saving restores it at the level
            selected above.
          </PolicyNote>
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
          <button className="button primary" type="submit" disabled={busy}>
            <ShieldCheck /> Save access
          </button>
        </footer>
      </form>
      {confirmDialog}
    </Modal>
  );
}


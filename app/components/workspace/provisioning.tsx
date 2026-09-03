"use client";

/**
 * The dialog KnowHow staff use to stand a customer organization up.
 *
 * Nothing a customer ever sees, which is exactly why it does not belong in the
 * file that holds the customer-facing workspace.
 */
import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  File,
  LoaderCircle,
  Mail,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type {
  PlatformProvisioningResult,
  PlatformProvisioningRun,
  WorkspaceRole,
} from "../../../lib/knowhow-types";
import { uploadProvisioningLogo } from "../../../lib/knowhow-client";
import { SelectMenu } from "../select-menu";
import { Modal } from "./primitives";
import {
  formatBytes,
  messageFromError,
  workspaceRoleLabel,
} from "./formatting";

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

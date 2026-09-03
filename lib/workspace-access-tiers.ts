import { type WorkspaceRole } from "./guide-contracts";
import type { OrganizationRole } from "./knowhow-types";

/**
 * The four levels of workspace access a person can hold.
 *
 * These are a view over the stored `WorkspaceRole[]`, not a replacement for
 * it: `policy.ts` still decides every action from the underlying roles, so
 * nothing re-authorizes and existing memberships keep working untouched.
 *
 * They exist because the stored shape is a set, and a set is the wrong thing
 * to ask anyone to reason about. Five checkboxes describe thirty-two possible
 * combinations, most of which are incoherent — a creator who cannot read, a
 * reviewer who cannot see the drafts assigned to them — and the interface
 * offered all of them equally. A ladder has four rungs, each containing the
 * one below, so there is one question to answer and no combination to check.
 */
export const ACCESS_TIERS = ["viewer", "creator", "publisher", "admin"] as const;

export type AccessTier = (typeof ACCESS_TIERS)[number];

/**
 * The roles each rung writes. Cumulative by construction: every rung lists the
 * roles of the rung below it, so "contains the one beneath" is a property of
 * the data rather than a promise made in the interface copy.
 *
 * `reviewer` sits with `publisher` because reviewing is a publishing act.
 * Holding them separately is what let a workspace require review while having
 * nobody able to complete one.
 */
const TIER_ROLES: Record<AccessTier, readonly WorkspaceRole[]> = {
  viewer: ["viewer"],
  creator: ["viewer", "creator"],
  publisher: ["viewer", "creator", "reviewer", "publisher"],
  admin: ["viewer", "creator", "reviewer", "publisher", "administrator"],
};

export const ACCESS_TIER_LABELS: Record<AccessTier, string> = {
  viewer: "Viewer",
  creator: "Creator",
  publisher: "Publisher",
  admin: "Admin",
};

/**
 * What each rung adds to the one below. Written as the difference rather than
 * the whole, because that is the only part the reader is deciding about.
 */
export const ACCESS_TIER_SUMMARIES: Record<AccessTier, string> = {
  viewer: "Reads the guides shared with them.",
  creator: "Also captures and writes guides, and edits their own drafts.",
  publisher:
    "Also reviews other people's drafts, and publishes or archives anything.",
  admin: "Also manages people, groups, settings, and the audit log.",
};

export function rolesForTier(tier: AccessTier): WorkspaceRole[] {
  return [...TIER_ROLES[tier]];
}

/**
 * The rung a stored role set sits on, by the highest capability it carries.
 *
 * Memberships written before the ladder existed can hold combinations no rung
 * produces — `reviewer` alone, or `publisher` without `creator`. Reading by
 * highest capability keeps those honest: someone who can review is shown as a
 * Publisher rather than demoted to Viewer by a set the ladder cannot express.
 * Saving then writes the canonical set for that rung.
 */
export function tierForRoles(roles: readonly WorkspaceRole[]): AccessTier {
  if (roles.includes("administrator")) return "admin";
  if (roles.includes("publisher") || roles.includes("reviewer")) {
    return "publisher";
  }
  if (roles.includes("creator")) return "creator";
  return "viewer";
}

/**
 * Whether a stored set already matches its rung exactly. A membership that
 * does not is legacy data being displayed at its nearest rung, which is worth
 * saying where an administrator can see it.
 */
export function isCanonicalForTier(roles: readonly WorkspaceRole[]): boolean {
  const canonical = new Set(rolesForTier(tierForRoles(roles)));
  return (
    canonical.size === new Set(roles).size &&
    roles.every((role) => canonical.has(role))
  );
}

/**
 * The levels a workspace invitation may grant. Administrator is deliberately
 * absent: `signInviteToken` refuses it, so the two agree by type rather than
 * by both remembering.
 *
 * These three share their names with the roles an invitation token already
 * carries, which is what lets the wire format stay unchanged — the name is
 * expanded into the level's full role set when the invitation is redeemed.
 */
export type InvitableTier = Exclude<AccessTier, "admin">;

export const INVITABLE_TIERS: readonly InvitableTier[] = [
  "viewer",
  "creator",
  "publisher",
];

/**
 * Organization access, on the same two-question footing as workspace access.
 *
 * The stored shape offers four roles — owner, administrator, billing and
 * security_auditor — but only one line has ever been enforced: owners appoint
 * people and change roles, and everyone else with organization access can
 * rename and add workspaces. Billing granted nothing the interface acted on,
 * and security auditor granted a subset of what administrator already had.
 * Four names for two levels of authority is three names too many.
 *
 * As with workspace access this is a view over the stored roles. Nothing
 * re-authorizes: the command layer still requires `owner` for appointments and
 * role changes exactly as before.
 */
export const ORGANIZATION_TIERS = ["administrator", "owner"] as const;

export type OrganizationTier = (typeof ORGANIZATION_TIERS)[number];

const ORGANIZATION_TIER_ROLES: Record<
  OrganizationTier,
  readonly OrganizationRole[]
> = {
  administrator: ["administrator"],
  owner: ["owner"],
};

export const ORGANIZATION_TIER_LABELS: Record<OrganizationTier, string> = {
  administrator: "Administrator",
  owner: "Owner",
};

export const ORGANIZATION_TIER_SUMMARIES: Record<OrganizationTier, string> = {
  administrator:
    "Organization details and the workspace directory. Cannot change who has organization access.",
  owner:
    "Everything an administrator can do, plus appointing people and changing their access.",
};

export function rolesForOrganizationTier(
  tier: OrganizationTier,
): OrganizationRole[] {
  return [...ORGANIZATION_TIER_ROLES[tier]];
}

/**
 * Only ownership is a real step up, so anything that is not an owner reads as
 * an administrator. Billing and security auditor are weaker than that in
 * practice, which is why a membership holding one is reported as non-canonical
 * — saving it at this level grants administrator rather than describing what
 * it already had, and the interface says so before it happens.
 */
export function organizationTierForRoles(
  roles: readonly OrganizationRole[],
): OrganizationTier {
  return roles.includes("owner") ? "owner" : "administrator";
}

export function isCanonicalForOrganizationTier(
  roles: readonly OrganizationRole[],
): boolean {
  const canonical = rolesForOrganizationTier(organizationTierForRoles(roles));
  return (
    roles.length === canonical.length &&
    roles.every((role) => canonical.includes(role))
  );
}

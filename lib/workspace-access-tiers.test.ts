import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACCESS_TIERS,
  INVITABLE_TIERS,
  isCanonicalForOrganizationTier,
  isCanonicalForTier,
  ORGANIZATION_TIERS,
  organizationTierForRoles,
  rolesForOrganizationTier,
  rolesForTier,
  tierForRoles,
} from "./workspace-access-tiers";

describe("access tiers", () => {
  // The whole point of a ladder is that each rung contains the one below it,
  // so nobody has to reason about a combination. If that stops being true the
  // interface starts lying about what a level means.
  it("each level contains every role of the level below", () => {
    for (let index = 1; index < ACCESS_TIERS.length; index += 1) {
      const lower = new Set(rolesForTier(ACCESS_TIERS[index - 1]));
      const higher = new Set(rolesForTier(ACCESS_TIERS[index]));
      for (const role of lower) {
        assert.ok(
          higher.has(role),
          `${ACCESS_TIERS[index]} must include ${role} from ${ACCESS_TIERS[index - 1]}`,
        );
      }
      assert.ok(higher.size > lower.size, "each level must add something");
    }
  });

  it("round-trips every level through its role set", () => {
    for (const tier of ACCESS_TIERS) {
      assert.equal(tierForRoles(rolesForTier(tier)), tier);
      assert.ok(isCanonicalForTier(rolesForTier(tier)));
    }
  });

  it("never grants administrator below the admin level", () => {
    for (const tier of ACCESS_TIERS.filter((item) => item !== "admin")) {
      assert.ok(!rolesForTier(tier).includes("administrator"));
    }
  });

  it("gives publishers the reviewer role", () => {
    // Splitting these is what let a workspace require review while having
    // nobody able to complete one.
    assert.ok(rolesForTier("publisher").includes("reviewer"));
    assert.ok(rolesForTier("admin").includes("reviewer"));
  });

  it("never offers administrator as an invitation level", () => {
    assert.ok(!INVITABLE_TIERS.includes("admin" as never));
  });

  describe("legacy role sets", () => {
    // Memberships written before the ladder can hold combinations no level
    // produces. Reading by highest capability keeps them honest.
    it("reads a reviewer-only membership as a publisher", () => {
      assert.equal(tierForRoles(["reviewer"]), "publisher");
      assert.ok(!isCanonicalForTier(["reviewer"]));
    });

    it("reads a publisher without creator as a publisher", () => {
      assert.equal(tierForRoles(["publisher"]), "publisher");
      assert.ok(!isCanonicalForTier(["publisher"]));
    });

    it("reads an administrator-only membership as admin", () => {
      assert.equal(tierForRoles(["administrator"]), "admin");
      assert.ok(!isCanonicalForTier(["administrator"]));
    });

    it("reads an empty role set as viewer", () => {
      assert.equal(tierForRoles([]), "viewer");
    });

    it("ignores order when checking canonical form", () => {
      assert.ok(isCanonicalForTier(["creator", "viewer"]));
    });
  });
});

describe("organization access tiers", () => {
  it("round-trips both levels", () => {
    for (const tier of ORGANIZATION_TIERS) {
      assert.equal(
        organizationTierForRoles(rolesForOrganizationTier(tier)),
        tier,
      );
      assert.ok(isCanonicalForOrganizationTier(rolesForOrganizationTier(tier)));
    }
  });

  it("treats ownership as the only step up", () => {
    assert.equal(organizationTierForRoles(["owner"]), "owner");
    assert.equal(organizationTierForRoles(["administrator"]), "administrator");
    assert.equal(organizationTierForRoles([]), "administrator");
  });

  // Owner must survive being held alongside anything else, because the
  // command layer still requires exactly that role to appoint people.
  it("keeps owner when it is held with other roles", () => {
    assert.equal(organizationTierForRoles(["billing", "owner"]), "owner");
    assert.ok(rolesForOrganizationTier("owner").includes("owner"));
  });

  // Billing and security auditor are weaker than administrator, so a
  // membership holding one is not canonical: saving it grants more than it
  // had, and the dialog has to say so first.
  it("reports the weaker legacy roles as non-canonical", () => {
    for (const role of ["billing", "security_auditor"] as const) {
      assert.equal(organizationTierForRoles([role]), "administrator");
      assert.ok(
        !isCanonicalForOrganizationTier([role]),
        `${role} must be flagged as an upgrade before saving`,
      );
    }
  });

  it("never writes billing or security auditor", () => {
    for (const tier of ORGANIZATION_TIERS) {
      const written = rolesForOrganizationTier(tier);
      assert.ok(!written.includes("billing"));
      assert.ok(!written.includes("security_auditor"));
    }
  });
});

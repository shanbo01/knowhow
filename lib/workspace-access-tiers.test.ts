import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACCESS_TIERS,
  INVITABLE_TIERS,
  isCanonicalForTier,
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

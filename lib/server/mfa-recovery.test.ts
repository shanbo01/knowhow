import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AppwriteException } from "node-appwrite";
import { issueRecoveryCodes, type RecoveryCodeAccount } from "./mfa-recovery";

/** Records which of the two Appwrite calls the decision actually reached. */
function account(options: {
  hasRecoveryCode: boolean;
  createThrows?: unknown;
}): RecoveryCodeAccount & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listMFAFactors: async () => {
      calls.push("list");
      return { recoveryCode: options.hasRecoveryCode };
    },
    createMFARecoveryCodes: async () => {
      calls.push("create");
      if (options.createThrows) throw options.createThrows;
      return { recoveryCodes: ["created-1", "created-2"] };
    },
    updateMFARecoveryCodes: async () => {
      calls.push("update");
      return { recoveryCodes: ["updated-1", "updated-2"] };
    },
  };
}

describe("issueRecoveryCodes", () => {
  it("mints a first set when the account has none", async () => {
    const target = account({ hasRecoveryCode: false });
    const result = await issueRecoveryCodes(target);
    assert.deepEqual(result.recoveryCodes, ["created-1", "created-2"]);
    assert.deepEqual(target.calls, ["list", "create"]);
  });

  // Minting over an existing set is what returned codes to the screen that
  // were not the codes being stored, so an existing set must be replaced.
  it("replaces an existing set rather than minting beside it", async () => {
    const target = account({ hasRecoveryCode: true });
    const result = await issueRecoveryCodes(target);
    assert.deepEqual(result.recoveryCodes, ["updated-1", "updated-2"]);
    assert.deepEqual(target.calls, ["list", "update"]);
  });

  // The factor listing and the stored codes can disagree; a conflict from
  // create means they exist after all, so fall through to replacing them.
  it("falls back to replacing when create reports a conflict", async () => {
    const target = account({
      hasRecoveryCode: false,
      createThrows: new AppwriteException("exists", 409),
    });
    const result = await issueRecoveryCodes(target);
    assert.deepEqual(result.recoveryCodes, ["updated-1", "updated-2"]);
    assert.deepEqual(target.calls, ["list", "create", "update"]);
  });

  it("propagates failures that are not a conflict", async () => {
    const target = account({
      hasRecoveryCode: false,
      createThrows: new AppwriteException("rate limited", 429),
    });
    await assert.rejects(
      () => issueRecoveryCodes(target),
      (error: unknown) =>
        error instanceof AppwriteException && error.code === 429,
    );
    assert.deepEqual(target.calls, ["list", "create"]);
  });

  it("propagates a non-Appwrite failure untouched", async () => {
    const target = account({
      hasRecoveryCode: false,
      createThrows: new TypeError("network down"),
    });
    await assert.rejects(
      () => issueRecoveryCodes(target),
      (error: unknown) => error instanceof TypeError,
    );
  });
});

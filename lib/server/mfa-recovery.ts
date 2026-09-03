import { AppwriteException } from "node-appwrite";

/**
 * The two calls Appwrite offers for recovery codes, narrowed to what this
 * decision needs. Keeping the shape structural rather than importing Account
 * lets the decision be tested without an Appwrite client.
 */
export type RecoveryCodeAccount = {
  listMFAFactors: () => Promise<{ recoveryCode: boolean }>;
  createMFARecoveryCodes: () => Promise<{ recoveryCodes: string[] }>;
  updateMFARecoveryCodes: () => Promise<{ recoveryCodes: string[] }>;
};

/**
 * Hands back a usable set of recovery codes whether or not the account has
 * some already.
 *
 * Appwrite splits this in two: `create` mints a first set and refuses when one
 * exists, `update` replaces an existing set. Two endpoints each picked one and
 * both rendered the same "save your recovery codes" screen, which is how an
 * account could be shown a set that was not the set being stored — the codes
 * on screen were rejected at sign-in while the authenticator still worked.
 *
 * The choice lives here so both callers make it the same way, and the fallback
 * covers the case where the factor listing and the stored codes disagree.
 */
export async function issueRecoveryCodes(account: RecoveryCodeAccount) {
  const factors = await account.listMFAFactors();
  if (factors.recoveryCode) return account.updateMFARecoveryCodes();
  try {
    return await account.createMFARecoveryCodes();
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 409) {
      return account.updateMFARecoveryCodes();
    }
    throw error;
  }
}

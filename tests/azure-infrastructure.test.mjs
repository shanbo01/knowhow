import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { exactControlledAppwriteEndpoint } from "../scripts/controlled-appwrite-endpoint.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Azure Qatar infrastructure is reproducible, minimal, and deny-by-default", async () => {
  const [subscription, platform, deploy, bootstrap] = await Promise.all([
    read("infrastructure/azure/subscription.bicep"),
    read("infrastructure/azure/main.bicep"),
    read("infrastructure/azure/Deploy-KnowHowAzure.ps1"),
    read("infrastructure/azure/bootstrap-appwrite.sh"),
  ]);

  assert.match(subscription, /param location string = 'qatarcentral'/);
  assert.match(subscription, /param vmSize string = 'Standard_B2s'/);
  assert.doesNotMatch(subscription + platform, /managedClusters|Microsoft\.ContainerService|AKS/);
  assert.match(platform, /securityType: 'TrustedLaunch'/);
  assert.match(platform, /destinationPortRange: '443'/);
  assert.match(platform, /name: 'Deny-All-Inbound'/);
  assert.doesNotMatch(platform, /destinationPortRange: '22'/);
  assert.match(platform, /allowSharedKeyAccess: false/);
  assert.match(platform, /Standard_ZRS/);
  assert.match(platform, /standardTierStorageRedundancy: 'LocallyRedundant'/);
  assert.match(platform, /Microsoft\.RecoveryServices\/vaults\/backupPolicies/);
  assert.match(platform, /AzureMonitorLinuxAgent/);
  assert.match(platform, /enablePurgeProtection: true/);
  assert.match(deploy, /Azure subscription 1/);
  assert.match(deploy, /\[switch\]\$ValidateOnly/);
  assert.match(bootstrap, /appwrite\/appwrite\/\$\{APPWRITE_VERSION\}/);
  assert.match(bootstrap, /COMPOSE_SHA256=6466d116dffadb4341b3366b704f1dd0c62f5d602dc4952781f7d389b5c38ff6/);
  assert.match(bootstrap, /_APP_CONSOLE_WHITELIST_IPS/);
  assert.match(bootstrap, /age --encrypt/);
  assert.match(bootstrap, /docker compose stop/);
  assert.match(bootstrap, /find \. -type f ! -name SHA256SUMS/);
});

test("restore tooling refuses an in-place or ambiguous restore", async () => {
  const restore = await read("infrastructure/azure/restore-appwrite.sh");
  assert.match(restore, /fresh-instance-only:\$\{BACKUP_BLOB/);
  assert.match(restore, /restore-completed/);
  assert.match(restore, /age --decrypt/);
  assert.match(restore, /sha256sum --check SHA256SUMS/);
});

test("all controlled gates share the exact Azure Qatar endpoint boundary", () => {
  const endpoint =
    "https://knowhowbeta-abc123.qatarcentral.cloudapp.azure.com/v1";
  assert.equal(
    exactControlledAppwriteEndpoint(endpoint, "azure-qatar-central"),
    endpoint,
  );
  assert.equal(exactControlledAppwriteEndpoint(endpoint), null);
  assert.equal(
    exactControlledAppwriteEndpoint(
      "https://knowhowbeta-abc123.qatarcentral.cloudapp.azure.com:443/v1",
      "azure-qatar-central",
    ),
    null,
  );
  assert.equal(
    exactControlledAppwriteEndpoint(
      "https://knowhowbeta-abc123.uaenorth.cloudapp.azure.com/v1",
      "azure-qatar-central",
    ),
    null,
  );
  assert.equal(
    exactControlledAppwriteEndpoint(
      "https://fra.cloud.appwrite.io/v1",
      "appwrite-cloud-frankfurt",
    ),
    "https://fra.cloud.appwrite.io/v1",
  );
});

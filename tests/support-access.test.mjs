import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { build } from "vite";

const root = path.resolve(import.meta.dirname, "..");
let outputDirectory;
let access;

before(async () => {
  outputDirectory = await mkdtemp(path.join(tmpdir(), "rivet-access-"));
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    build: {
      emptyOutDir: false,
      outDir: outputDirectory,
      target: "es2022",
      minify: false,
      lib: {
        entry: path.join(root, "tests", "helpers", "access-entry.ts"),
        formats: ["es"],
        fileName: () => "access.mjs",
      },
    },
  });
  access = await import(
    `${pathToFileURL(path.join(outputDirectory, "access.mjs")).href}?test=${Date.now()}`
  );
});

after(async () => {
  if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
});

async function openMigratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const file of [
    "0000_zippy_spacker_dave.sql",
    "0001_spotty_korath.sql",
  ]) {
    const migration = await readFile(
      new URL(`../drizzle/${file}`, import.meta.url),
      "utf8",
    );
    for (const sql of migration.split("--> statement-breakpoint")) {
      if (sql.trim()) database.exec(sql);
    }
  }
  return database;
}

// Minimal D1-shaped adapter over node:sqlite so repository queries run
// against the same migrated schema the triggers enforce.
function d1Adapter(database) {
  return {
    prepare(sql) {
      const bound = { values: [] };
      return {
        bind(...values) {
          bound.values = values;
          return this;
        },
        first() {
          const row = database.prepare(sql).get(...bound.values);
          return row ?? null;
        },
        all() {
          const rows = database.prepare(sql).all(...bound.values);
          return { success: true, results: rows };
        },
        run() {
          const info = database.prepare(sql).run(...bound.values);
          return { success: true, meta: { changes: info.changes } };
        },
      };
    },
    async batch(statements) {
      return statements.map((statement) => statement.run());
    },
  };
}

function seedWorkspace(database, { workspaceId = "w1", name = "Customer Co" } = {}) {
  database.exec(
    `INSERT INTO entities (id, name, status, created_by) VALUES ('entity1', '${name}', 'active', 'u-admin')`,
  );
  database.exec(
    `INSERT INTO workspaces (id, entity_id, name, slug, status, self_serve, created_by) VALUES ('${workspaceId}', 'entity1', '${name}', '${workspaceId}', 'active', 0, 'u-admin')`,
  );
  database.exec(
    `INSERT INTO workspace_settings (workspace_id, accent_color, click_target_color) VALUES ('${workspaceId}', '#1f7653', '#ef6f47')`,
  );
  database.exec(
    `INSERT INTO groups (id, workspace_id, name, slug, kind, created_by) VALUES ('g-all', '${workspaceId}', 'All Employees', 'all-employees', 'all_members', 'u-admin')`,
  );
  database.exec(
    `INSERT INTO workspace_members (workspace_id, user_id, email, display_name, status) VALUES ('${workspaceId}', 'u-admin', 'admin@customer.com', 'Admin', 'active')`,
  );
  database.exec(
    `INSERT INTO workspace_member_roles (workspace_id, user_id, role, granted_by) VALUES ('${workspaceId}', 'u-admin', 'administrator', 'u-admin')`,
  );
}

function seedPendingSupportRequest(database, { id = "req-1", requester = "u-support", email = "support@rivet.app", role = "viewer", hours = 4 } = {}) {
  database.exec(
    `INSERT INTO support_access_requests
       (id, workspace_id, requester_user_id, requester_email, requester_name,
        requested_role, reason, requested_duration_hours, status)
     VALUES ('${id}', 'w1', '${requester}', '${email}', 'Platform Support',
             '${role}', 'Investigating a capture failure', ${hours}, 'pending')`,
  );
}

function approveRequest(database, { requestId = "req-1", grantedRole = "viewer", grantId = "grant-1", decidedBy = "u-admin" } = {}) {
  const grantReference = grantId === null ? "NULL" : `'${grantId}'`;
  database.exec(
    `UPDATE support_access_requests
     SET status = 'approved', decided_by = '${decidedBy}', decided_at = CURRENT_TIMESTAMP,
         granted_role = '${grantedRole}', grant_id = ${grantReference}
     WHERE id = '${requestId}'`,
  );
}

function insertGrant(database, { requestId = "req-1", grantId = "grant-1", expiresAt = "2099-01-01T00:00:00Z", approvedBy = "u-admin", user = "u-support", role = "viewer" } = {}) {
  database.exec(
    `INSERT INTO support_access_grants
       (id, request_id, workspace_id, user_id, email, display_name, role,
        status, approved_by, granted_at, expires_at)
     VALUES ('${grantId}', '${requestId}', 'w1', '${user}', 'support@rivet.app', 'Platform Support',
             '${role}', 'active', '${approvedBy}', CURRENT_TIMESTAMP, '${expiresAt}')`,
  );
}

test("expired support grants vanish from workspace access and expire via sweep", async () => {
  const database = await openMigratedDatabase();
  seedWorkspace(database);
  seedPendingSupportRequest(database);
  approveRequest(database);
  insertGrant(database, { expiresAt: "2099-01-01T00:00:00Z" });

  const repository = new access.D1RivetRepository(d1Adapter(database));
  const active = await repository.listWorkspaceAccess("u-support");
  assert.equal(active.length, 1);
  assert.equal(active[0].workspaceId, "w1");
  assert.deepEqual(active[0].roles, ["viewer"]);
  assert.ok(active[0].supportGrant, "access should be tagged as a support grant");
  assert.equal(active[0].supportGrant.grantId, "grant-1");

  // Expiry is enforced on every access resolution: backdate the grant.
  database.exec(`UPDATE support_access_grants SET expires_at = '2000-01-01T00:00:00Z' WHERE id = 'grant-1'`);
  const afterExpiry = await repository.listWorkspaceAccess("u-support");
  assert.equal(afterExpiry.length, 0, "an expired grant must not resolve to access");

  // The sweep records the expiration and closes the grant.
  const expired = await repository.expireSupportGrants();
  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, "grant-1");
  const row = database.prepare("SELECT status, ended_at FROM support_access_grants WHERE id = 'grant-1'").get();
  assert.equal(row.status, "expired");
  assert.ok(row.ended_at);
  assert.equal((await repository.expireSupportGrants()).length, 0, "sweep must be idempotent");
});

test("a real membership always takes precedence over a support grant", async () => {
  const database = await openMigratedDatabase();
  seedWorkspace(database);
  seedPendingSupportRequest(database);
  approveRequest(database);
  insertGrant(database);
  // The support user later becomes a real member.
  database.exec(
    `INSERT INTO workspace_members (workspace_id, user_id, email, display_name, status) VALUES ('w1', 'u-support', 'support@rivet.app', 'Support', 'active')`,
  );
  database.exec(
    `INSERT INTO workspace_member_roles (workspace_id, user_id, role, granted_by) VALUES ('w1', 'u-support', 'viewer', 'u-admin')`,
  );

  const repository = new access.D1RivetRepository(d1Adapter(database));
  const [entry] = await repository.listWorkspaceAccess("u-support");
  assert.equal(entry.workspaceId, "w1");
  assert.equal(entry.supportGrant, undefined, "membership access must not carry the support grant tag");
  assert.ok(entry.membershipStatus === "active");
});

test("support grant triggers reject self-approval, stacking, and invalid transitions", async () => {
  const database = await openMigratedDatabase();
  seedWorkspace(database);
  seedPendingSupportRequest(database);

  // Approving yourself is blocked at the request decision itself.
  assert.throws(
    () => approveRequest(database, { decidedBy: "u-support" }),
    /invalid support request decision/,
  );

  // Approval requires the granted role and grant reference.
  assert.throws(
    () => approveRequest(database, { grantedRole: "viewer", grantId: null }),
    /invalid support request decision/,
  );

  approveRequest(database);
  insertGrant(database);

  // A second active grant for the same workspace + user is rejected.
  assert.throws(
    () => insertGrant(database, { grantId: "grant-2" }),
    /an active support grant already exists/,
  );

  // A grant requires its request to be approved first.
  seedPendingSupportRequest(database, { id: "req-2" });
  assert.throws(
    () => insertGrant(database, { requestId: "req-2", grantId: "grant-x" }),
    /support grant requires an approved request/,
  );

  // Even an approved request cannot be turned into a self-approved grant.
  seedPendingSupportRequest(database, { id: "req-3" });
  approveRequest(database, { requestId: "req-3", grantId: "grant-3" });
  assert.throws(
    () => insertGrant(database, { requestId: "req-3", grantId: "grant-3", approvedBy: "u-support" }),
    /support grant cannot be self-approved/,
  );

  // Grants must start unexpired.
  seedPendingSupportRequest(database, { id: "req-4" });
  approveRequest(database, { requestId: "req-4", grantId: "grant-4" });
  assert.throws(
    () => insertGrant(database, { requestId: "req-4", grantId: "grant-4", expiresAt: "2000-01-01T00:00:00Z" }),
    /support grant is already expired/,
  );

  // Only active grants may end, and revocations must record who revoked.
  assert.throws(
    () => {
      database.exec(
        `UPDATE support_access_grants SET status = 'revoked' WHERE id = 'grant-1'`,
      );
    },
    /invalid support grant transition/,
  );
  // Ending without a reason is fine for natural expiry, but revocation needs a revoker.
  assert.throws(
    () => {
      database.exec(
        `UPDATE support_access_grants SET status = 'revoked', ended_at = CURRENT_TIMESTAMP
         WHERE id = 'grant-1'`,
      );
    },
    /invalid support grant transition/,
  );
  database.exec(
    `UPDATE support_access_grants SET status = 'revoked', ended_at = CURRENT_TIMESTAMP, revoked_by = 'u-admin' WHERE id = 'grant-1'`,
  );
  const row = database.prepare("SELECT status, revoked_by FROM support_access_grants WHERE id = 'grant-1'").get();
  assert.equal(row.status, "revoked");
  assert.equal(row.revoked_by, "u-admin");
  // A revoked grant cannot be revived.
  assert.throws(
    () => {
      database.exec(
        `UPDATE support_access_grants SET status = 'active', ended_at = NULL
         WHERE id = 'grant-1'`,
      );
    },
    /invalid support grant transition/,
  );
});

test("a denied or cancelled request cannot be re-decided", async () => {
  const database = await openMigratedDatabase();
  seedWorkspace(database);
  seedPendingSupportRequest(database);
  database.exec(
    `UPDATE support_access_requests
     SET status = 'denied', decided_by = 'u-admin', decided_at = CURRENT_TIMESTAMP
     WHERE id = 'req-1'`,
  );
  assert.throws(
    () => {
      database.exec(
        `UPDATE support_access_requests
         SET status = 'approved', decided_by = 'u-admin', decided_at = CURRENT_TIMESTAMP,
             granted_role = 'viewer', grant_id = 'grant-1'
         WHERE id = 'req-1'`,
      );
    },
    /invalid support request decision/,
  );
});

test("self-serve workspace creation is capped atomically by the trigger", async () => {
  const database = await openMigratedDatabase();
  database.exec(
    `INSERT INTO entities (id, name, status, created_by) VALUES ('e1', 'E1', 'active', 'u-self')`,
  );
  database.exec(
    `INSERT INTO workspaces (id, entity_id, name, slug, status, self_serve, created_by) VALUES ('w1', 'e1', 'W1', 'w1', 'active', 1, 'u-self')`,
  );
  // A second self-serve workspace by the same user fails inside the insert.
  assert.throws(
    () => {
      database.exec(
        `INSERT INTO entities (id, name, status, created_by) VALUES ('e2', 'E2', 'active', 'u-self')`,
      );
      database.exec(
        `INSERT INTO workspaces (id, entity_id, name, slug, status, self_serve, created_by) VALUES ('w2', 'e1', 'W2', 'w2', 'active', 1, 'u-self')`,
      );
    },
    /self-serve workspace limit reached/,
  );
  // Platform-provisioned workspaces are not limited.
  database.exec(
    `INSERT INTO workspaces (id, entity_id, name, slug, status, self_serve, created_by) VALUES ('w3', 'e1', 'W3', 'w3', 'active', 0, 'u-self')`,
  );
  // Raising the platform setting unlocks creation for another user.
  database.exec(
    `INSERT INTO entities (id, name, status, created_by) VALUES ('e3', 'E3', 'active', 'u-other')`,
  );
  database.exec(
    `INSERT INTO workspaces (id, entity_id, name, slug, status, self_serve, created_by) VALUES ('w4', 'e3', 'W4', 'w4', 'active', 1, 'u-other')`,
  );
  database.exec(
    `UPDATE platform_settings SET value_json = '2' WHERE key = 'selfServiceWorkspaceLimit'`,
  );
  database.exec(
    `INSERT INTO workspaces (id, entity_id, name, slug, status, self_serve, created_by) VALUES ('w5', 'e1', 'W5', 'w5', 'active', 1, 'u-self')`,
  );
});

test("administrator appointments are single-use, exact-email, and expiring", async () => {
  const database = await openMigratedDatabase();
  seedWorkspace(database);
  database.exec(
    `INSERT INTO admin_appointments (id, workspace_id, token_hash, email, status, expires_at, created_by)
     VALUES ('appt-1', 'w1', 'hash-1', 'client@example.com', 'active', '2099-01-01T00:00:00Z', 'u-platform')`,
  );
  database.exec(
    `INSERT INTO workspace_members (workspace_id, user_id, email, display_name, status) VALUES ('w1', 'u-client', 'client@example.com', 'Client', 'active')`,
  );

  // The wrong email cannot accept the appointment.
  assert.throws(
    () => {
      database.exec(
        `UPDATE admin_appointments
         SET status = 'accepted', accepted_by = 'u-other', accepted_at = CURRENT_TIMESTAMP
         WHERE id = 'appt-1'`,
      );
    },
    /appointment unavailable/,
  );

  // Acceptance requires the membership to exist with the exact email.
  database.exec(
    `UPDATE admin_appointments
     SET status = 'accepted', accepted_by = 'u-client', accepted_at = CURRENT_TIMESTAMP
     WHERE id = 'appt-1'`,
  );
  const row = database.prepare("SELECT status FROM admin_appointments WHERE id = 'appt-1'").get();
  assert.equal(row.status, "accepted");

  // Accepted appointments cannot be accepted again or revoked.
  database.exec(
    `INSERT INTO admin_appointments (id, workspace_id, token_hash, email, status, expires_at, created_by)
     VALUES ('appt-2', 'w1', 'hash-2', 'other@example.com', 'accepted', '2099-01-01T00:00:00Z', 'u-platform')`,
  );
  assert.throws(
    () => {
      database.exec(
        `UPDATE admin_appointments
         SET status = 'accepted', accepted_by = 'u-other', accepted_at = CURRENT_TIMESTAMP
         WHERE id = 'appt-2'`,
      );
    },
    /appointment unavailable/,
  );

  // Expired appointments cannot be accepted.
  database.exec(
    `INSERT INTO admin_appointments (id, workspace_id, token_hash, email, status, expires_at, created_by)
     VALUES ('appt-3', 'w1', 'hash-3', 'client@example.com', 'active', '2000-01-01T00:00:00Z', 'u-platform')`,
  );
  assert.throws(
    () => {
      database.exec(
        `UPDATE admin_appointments
         SET status = 'accepted', accepted_by = 'u-client', accepted_at = CURRENT_TIMESTAMP
         WHERE id = 'appt-3'`,
      );
    },
    /appointment unavailable/,
  );
});

test("email-scoped invitations reject redemption by another account", async () => {
  const database = await openMigratedDatabase();
  seedWorkspace(database);
  database.exec(
    `INSERT INTO invitations (id, workspace_id, token_hash, label, email, role, status, max_uses, use_count, expires_at, created_by, created_via)
     VALUES ('inv-1', 'w1', 'hash-inv', 'Scoped invite', 'scoped@example.com', 'viewer', 'active', 1, 0, '2099-01-01T00:00:00Z', 'u-admin', 'standard')`,
  );
  // Wrong email redemption is rejected by the trigger.
  assert.throws(
    () => {
      database.exec(
        `INSERT INTO invite_redemptions (invitation_id, user_id, email, redeemed_at)
         VALUES ('inv-1', 'u-other', 'other@example.com', CURRENT_TIMESTAMP)`,
      );
    },
    /invitation unavailable/,
  );
  // Correct email redemption succeeds and exhausts the single-use link.
  database.exec(
    `INSERT INTO invite_redemptions (invitation_id, user_id, email, redeemed_at)
     VALUES ('inv-1', 'u-scoped', 'scoped@example.com', CURRENT_TIMESTAMP)`,
  );
  assert.throws(
    () => {
      database.exec(
        `INSERT INTO invite_redemptions (invitation_id, user_id, email, redeemed_at)
         VALUES ('inv-1', 'u-scoped2', 'scoped2@example.com', CURRENT_TIMESTAMP)`,
      );
    },
    /invitation unavailable/,
  );
  const invite = database.prepare("SELECT status, use_count FROM invitations WHERE id = 'inv-1'").get();
  assert.equal(invite.status, "exhausted");
  assert.equal(invite.use_count, 1);
});

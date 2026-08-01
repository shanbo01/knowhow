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
let security;

before(async () => {
  outputDirectory = await mkdtemp(path.join(tmpdir(), "rivet-security-"));
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
        entry: path.join(root, "tests", "helpers", "security-entry.ts"),
        formats: ["es"],
        fileName: () => "security.mjs",
      },
    },
  });
  security = await import(
    `${pathToFileURL(path.join(outputDirectory, "security.mjs")).href}?test=${Date.now()}`
  );
});

after(async () => {
  if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
});

function context(roles, guide = undefined) {
  return {
    isVerifiedIdentity: true,
    membershipStatus: "active",
    workspaceStatus: "active",
    roles,
    capabilities: [],
    guide,
  };
}

async function openMigratedDatabase() {
  const migration = await readFile(
    new URL("../drizzle/0000_zippy_spacker_dave.sql", import.meta.url),
    "utf8",
  );
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const sql of migration.split("--> statement-breakpoint")) {
    if (sql.trim()) database.exec(sql);
  }
  return database;
}

test("default-deny policy keeps target audiences out of drafts", () => {
  const draft = {
    revisionStatus: "draft",
    isAudienceMember: true,
    isAuthor: false,
    isAssignedReviewer: false,
  };
  assert.equal(security.authorize("guide.read", context(["viewer"], draft)).allowed, false);
  assert.equal(
    security.authorize(
      "guide.read",
      context(["reviewer"], { ...draft, revisionStatus: "review", isAssignedReviewer: true }),
    ).allowed,
    true,
  );
  assert.equal(
    security.authorize(
      "guide.read",
      context(["reviewer"], { ...draft, revisionStatus: "review", isAssignedReviewer: false }),
    ).allowed,
    false,
  );
  assert.equal(
    security.authorize(
      "guide.read",
      context(["viewer"], { ...draft, revisionStatus: "published" }),
    ).allowed,
    true,
  );
});

test("captured revisions require both review approval and privacy review", () => {
  const base = {
    revisionStatus: "review",
    sourceType: "capture",
    reviewApproved: true,
    privacyReviewed: false,
  };
  const missingPrivacy = security.authorize(
    "guide.publish",
    context(["publisher"], base),
  );
  assert.equal(missingPrivacy.allowed, false);
  assert.equal(missingPrivacy.code, "PRIVACY_REVIEW_REQUIRED");
  assert.equal(
    security.authorize(
      "guide.publish",
      context(["publisher"], { ...base, privacyReviewed: true }),
    ).allowed,
    true,
  );
});

test("roles remain separate from audiences", () => {
  const administrator = security.authorize(
    "workspace.groups.manage",
    context(["administrator"]),
  );
  const viewer = security.authorize(
    "workspace.groups.manage",
    context(["viewer"], { isAudienceMember: true }),
  );
  assert.equal(administrator.allowed, true);
  assert.equal(viewer.allowed, false);
});

test("platform provisioning and vault access remain separate capabilities", () => {
  assert.equal(
    security.authorize("platform.workspaces.manage", {
      isVerifiedIdentity: true,
      isPlatformAdministrator: false,
      roles: [],
    }).allowed,
    false,
  );
  assert.equal(
    security.authorize("platform.workspaces.manage", {
      isVerifiedIdentity: true,
      isPlatformAdministrator: true,
      roles: [],
    }).allowed,
    true,
  );
  assert.equal(security.authorize("vault.use", context(["viewer"])).allowed, false);
  assert.equal(
    security.authorize("vault.use", {
      ...context(["viewer"]),
      capabilities: ["vault"],
    }).allowed,
    true,
  );
  assert.equal(security.authorize("vault.use", context(["administrator"])).allowed, true);
  assert.equal(
    security.authorize("vault.use", {
      ...context(["viewer"]),
      capabilities: ["vault"],
      membershipStatus: "suspended",
    }).allowed,
    false,
  );
});

test("exact email-domain extraction rejects suffix and malformed matches", () => {
  assert.equal(security.extractExactEmailDomain("Person@Example.COM"), "example.com");
  assert.equal(security.extractExactEmailDomain("person@finance.example.com"), "finance.example.com");
  assert.notEqual(
    security.extractExactEmailDomain("person@finance.example.com"),
    "example.com",
  );
  assert.equal(security.extractExactEmailDomain("person@@example.com"), null);
  assert.equal(security.extractExactEmailDomain("person@-example.com"), null);
});

test("signed credentials are scoped, tamper-evident, and typed", async () => {
  const secret = "test-only-signing-secret-with-at-least-thirty-two-bytes";
  const now = Math.floor(Date.now() / 1000);
  const invite = await security.signInviteToken(
    {
      jti: "invitation-credential-0001",
      workspaceId: "workspace-a",
      expiresAt: now + 600,
      role: "viewer",
    },
    secret,
  );
  const claims = await security.verifyInviteToken(invite, secret);
  assert.equal(claims.workspaceId, "workspace-a");
  const tampered = invite.slice(0, -1) + (invite.endsWith("A") ? "B" : "A");
  await assert.rejects(
    security.verifyInviteToken(tampered, secret),
    /invalid/i,
  );
  await assert.rejects(security.verifyDeviceToken(invite, secret), /invalid/i);
});

test("SQLite guards enforce tenant audiences and append-only audit history", async () => {
  const migration = await readFile(
    new URL("../drizzle/0000_zippy_spacker_dave.sql", import.meta.url),
    "utf8",
  );
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const sql of migration.split("--> statement-breakpoint")) {
    if (sql.trim()) database.exec(sql);
  }

  database.exec(`
    INSERT INTO entities (id, name, created_by) VALUES ('entity-a', 'A', 'owner-a');
    INSERT INTO entities (id, name, created_by) VALUES ('entity-b', 'B', 'owner-b');
    INSERT INTO workspaces (id, entity_id, name, slug, created_by)
      VALUES ('workspace-a', 'entity-a', 'A', 'a', 'owner-a');
    INSERT INTO workspaces (id, entity_id, name, slug, created_by)
      VALUES ('workspace-b', 'entity-b', 'B', 'b', 'owner-b');
    INSERT INTO workspace_members (workspace_id, user_id, email)
      VALUES ('workspace-a', 'author-a', 'author@a.test');
    INSERT INTO workspace_members (workspace_id, user_id, email)
      VALUES ('workspace-b', 'user-b', 'user@b.test');
    INSERT INTO groups (id, workspace_id, name, slug, kind, created_by)
      VALUES ('group-b', 'workspace-b', 'Finance B', 'finance-b', 'custom', 'owner-b');
    INSERT INTO guides (id, workspace_id, title, slug, author_user_id)
      VALUES ('guide-a', 'workspace-a', 'Private A', 'private-a', 'author-a');
    INSERT INTO guide_revisions
      (id, guide_id, workspace_id, version, status, source_type, title, created_by)
      VALUES ('revision-a', 'guide-a', 'workspace-a', 1, 'draft', 'manual', 'Private A', 'author-a');
  `);
  assert.throws(
    () =>
      database.exec(
        `INSERT INTO guide_audiences (revision_id, subject_type, subject_id, granted_by)
         VALUES ('revision-a', 'group', 'group-b', 'author-a')`,
      ),
    /workspace mismatch/i,
  );
  assert.throws(
    () =>
      database.exec(
        `INSERT INTO guide_audiences (revision_id, subject_type, subject_id, granted_by)
         VALUES ('revision-a', 'user', 'user-b', 'author-a')`,
      ),
    /workspace mismatch/i,
  );

  database.exec(`
    INSERT INTO audit_heads (workspace_id, last_sequence, last_hash)
      VALUES ('workspace-a', 0, '');
    INSERT INTO audit_events
      (id, workspace_id, sequence, previous_hash, event_hash, actor_user_id,
       action, target_type, summary, occurred_at)
      VALUES ('event-1', 'workspace-a', 1,
       '0000000000000000000000000000000000000000000000000000000000000000',
       'hash-1', 'owner-a', 'guide.created', 'guide', 'Created',
       '2026-08-01T00:00:00.000Z');
  `);
  assert.throws(
    () => database.exec("UPDATE audit_events SET summary = 'changed' WHERE id = 'event-1'"),
    /append-only/i,
  );
  assert.throws(
    () => database.exec("DELETE FROM audit_events WHERE id = 'event-1'"),
    /append-only/i,
  );
  database.close();
});

test("published pointer stays live while a new draft is edited", async () => {
  const migration = await readFile(
    new URL("../drizzle/0000_zippy_spacker_dave.sql", import.meta.url),
    "utf8",
  );
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const sql of migration.split("--> statement-breakpoint")) {
    if (sql.trim()) database.exec(sql);
  }
  database.exec(`
    INSERT INTO entities (id, name, created_by) VALUES ('entity', 'Entity', 'author');
    INSERT INTO workspaces (id, entity_id, name, slug, created_by)
      VALUES ('workspace', 'entity', 'Workspace', 'workspace', 'author');
    INSERT INTO workspace_members (workspace_id, user_id, email)
      VALUES ('workspace', 'author', 'author@example.com');
    INSERT INTO guides
      (id, workspace_id, title, slug, author_user_id,
       current_published_revision_id, working_draft_revision_id)
      VALUES ('guide', 'workspace', 'Live guide', 'live-guide', 'author', 'v1', 'v2');
    INSERT INTO guide_revisions
      (id, guide_id, workspace_id, version, status, source_type, title, created_by,
       submitted_at, published_by, published_at)
      VALUES ('v1', 'guide', 'workspace', 1, 'published', 'manual', 'Live v1',
       'author', '2026-07-01T00:00:00Z', 'author', '2026-07-02T00:00:00Z');
    INSERT INTO guide_revisions
      (id, guide_id, workspace_id, version, status, source_type, title, created_by)
      VALUES ('v2', 'guide', 'workspace', 2, 'draft', 'manual', 'Draft v2', 'author');
    UPDATE guide_revisions SET title = 'Edited private v2' WHERE id = 'v2';
  `);
  const pointer = database
    .prepare(
      `SELECT current_published_revision_id AS published,
              working_draft_revision_id AS working FROM guides WHERE id = 'guide'`,
    )
    .get();
  assert.deepEqual({ ...pointer }, { published: "v1", working: "v2" });
  const live = database
    .prepare(
      `SELECT r.title FROM guides g JOIN guide_revisions r
       ON r.id = g.current_published_revision_id WHERE g.id = 'guide'`,
    )
    .get();
  assert.equal(live.title, "Live v1");
  database.close();
});

test("invitation redemption is atomic across limits, expiry, and workspace status", async () => {
  const database = await openMigratedDatabase();
  database.exec(`
    INSERT INTO entities (id, name, created_by) VALUES ('entity', 'Entity', 'owner');
    INSERT INTO workspaces (id, entity_id, name, slug, created_by)
      VALUES ('workspace', 'entity', 'Workspace', 'workspace', 'owner');
    INSERT INTO invitations
      (id, workspace_id, token_hash, label, role, status, max_uses, use_count,
       expires_at, created_by)
      VALUES ('invite', 'workspace', 'hash', 'One use', 'viewer', 'active', 1, 0,
       '2099-01-01T00:00:00.000Z', 'owner');
    INSERT INTO invite_redemptions (invitation_id, user_id, email)
      VALUES ('invite', 'first', 'first@example.com');
  `);
  assert.deepEqual(
    {
      ...database
        .prepare("SELECT status, use_count FROM invitations WHERE id = 'invite'")
        .get(),
    },
    { status: "exhausted", use_count: 1 },
  );

  assert.throws(() => {
    try {
      database.exec(`
        BEGIN;
        INSERT INTO workspace_members (workspace_id, user_id, email)
          VALUES ('workspace', 'second', 'second@example.com');
        INSERT INTO workspace_member_roles (workspace_id, user_id, role, granted_by)
          VALUES ('workspace', 'second', 'viewer', 'second');
        INSERT INTO invite_redemptions (invitation_id, user_id, email)
          VALUES ('invite', 'second', 'second@example.com');
        COMMIT;
      `);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }, /invitation unavailable/i);
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE user_id = 'second'")
      .get().count,
    0,
  );

  database.exec(`
    INSERT INTO invitations
      (id, workspace_id, token_hash, label, role, status, max_uses, use_count,
       expires_at, created_by)
      VALUES ('expired', 'workspace', 'expired-hash', 'Expired', 'viewer', 'active', 2, 0,
       '2020-01-01T00:00:00.000Z', 'owner');
  `);
  assert.throws(
    () =>
      database.exec(
        `INSERT INTO invite_redemptions (invitation_id, user_id, email)
         VALUES ('expired', 'third', 'third@example.com')`,
      ),
    /invitation unavailable/i,
  );
  database.exec(`
    INSERT INTO invitations
      (id, workspace_id, token_hash, label, role, status, max_uses, use_count,
       expires_at, created_by)
      VALUES ('suspended', 'workspace', 'suspended-hash', 'Suspended', 'viewer', 'active', 2, 0,
       '2099-01-01T00:00:00.000Z', 'owner');
    UPDATE workspaces SET status = 'suspended' WHERE id = 'workspace';
  `);
  assert.throws(
    () =>
      database.exec(
        `INSERT INTO invite_redemptions (invitation_id, user_id, email)
         VALUES ('suspended', 'fourth', 'fourth@example.com')`,
      ),
    /invitation unavailable/i,
  );
  database.close();
});

test("database guards preserve the final active administrator under stale checks", async () => {
  const database = await openMigratedDatabase();
  database.exec(`
    INSERT INTO entities (id, name, created_by) VALUES ('entity', 'Entity', 'owner');
    INSERT INTO workspaces (id, entity_id, name, slug, created_by)
      VALUES ('workspace', 'entity', 'Workspace', 'workspace', 'owner');
    INSERT INTO workspace_members (workspace_id, user_id, email)
      VALUES ('workspace', 'admin-a', 'a@example.com');
    INSERT INTO workspace_member_roles (workspace_id, user_id, role, granted_by)
      VALUES ('workspace', 'admin-a', 'administrator', 'owner');
  `);
  assert.throws(
    () =>
      database.exec(
        `DELETE FROM workspace_member_roles
         WHERE workspace_id = 'workspace' AND user_id = 'admin-a' AND role = 'administrator'`,
      ),
    /last active administrator/i,
  );
  assert.throws(
    () =>
      database.exec(
        `UPDATE workspace_members SET status = 'suspended'
         WHERE workspace_id = 'workspace' AND user_id = 'admin-a'`,
      ),
    /last active administrator/i,
  );

  database.exec(`
    INSERT INTO workspace_members (workspace_id, user_id, email)
      VALUES ('workspace', 'admin-b', 'b@example.com');
    INSERT INTO workspace_member_roles (workspace_id, user_id, role, granted_by)
      VALUES ('workspace', 'admin-b', 'administrator', 'owner');
    DELETE FROM workspace_member_roles
      WHERE workspace_id = 'workspace' AND user_id = 'admin-a' AND role = 'administrator';
  `);
  assert.throws(
    () =>
      database.exec(
        `DELETE FROM workspace_member_roles
         WHERE workspace_id = 'workspace' AND user_id = 'admin-b' AND role = 'administrator'`,
      ),
    /last active administrator/i,
  );
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM workspace_member_roles
         WHERE workspace_id = 'workspace' AND role = 'administrator'`,
      )
      .get().count,
    1,
  );
  database.close();
});

test("publish guards prevent a stale publisher from clearing the live pointer", async () => {
  const database = await openMigratedDatabase();
  database.exec(`
    INSERT INTO entities (id, name, created_by) VALUES ('entity', 'Entity', 'owner');
    INSERT INTO workspaces (id, entity_id, name, slug, created_by)
      VALUES ('workspace', 'entity', 'Workspace', 'workspace', 'owner');
    INSERT INTO workspace_members (workspace_id, user_id, email)
      VALUES ('workspace', 'author', 'author@example.com');
    INSERT INTO guides
      (id, workspace_id, title, slug, author_user_id, working_draft_revision_id)
      VALUES ('guide', 'workspace', 'Guide', 'guide', 'author', 'revision');
    INSERT INTO guide_revisions
      (id, guide_id, workspace_id, version, status, source_type, title, created_by)
      VALUES ('revision', 'guide', 'workspace', 1, 'review', 'manual', 'Guide', 'author');
    INSERT INTO review_assignments
      (revision_id, reviewer_user_id, status, assigned_by, decided_at)
      VALUES ('revision', 'author', 'approved', 'author', CURRENT_TIMESTAMP);
    UPDATE guide_revisions SET status = 'published', published_by = 'author',
      published_at = CURRENT_TIMESTAMP WHERE id = 'revision';
    UPDATE guides SET current_published_revision_id = 'revision',
      working_draft_revision_id = NULL WHERE id = 'guide';
  `);
  assert.throws(
    () =>
      database.exec(
        `UPDATE guides SET current_published_revision_id = NULL,
         working_draft_revision_id = NULL WHERE id = 'guide'`,
      ),
    /invalid guide publish transition/i,
  );
  assert.equal(
    database
      .prepare("SELECT current_published_revision_id AS revision FROM guides WHERE id = 'guide'")
      .get().revision,
    "revision",
  );
  database.close();
});

test("capture guards enforce scope, pause, completion, and discard invariants", async () => {
  const database = await openMigratedDatabase();
  database.exec(`
    INSERT INTO entities (id, name, created_by) VALUES ('entity', 'Entity', 'owner');
    INSERT INTO workspaces (id, entity_id, name, slug, created_by)
      VALUES ('workspace', 'entity', 'Workspace', 'workspace', 'owner');
    INSERT INTO workspace_members (workspace_id, user_id, email)
      VALUES ('workspace', 'creator', 'creator@example.com');
    INSERT INTO guides
      (id, workspace_id, title, slug, author_user_id, working_draft_revision_id)
      VALUES ('guide', 'workspace', 'Guide', 'guide', 'creator', 'revision');
    INSERT INTO guide_revisions
      (id, guide_id, workspace_id, version, status, source_type, title, created_by)
      VALUES ('revision', 'guide', 'workspace', 1, 'draft', 'capture', 'Guide', 'creator');
    INSERT INTO capture_sessions
      (id, workspace_id, user_id, status, capture_scope)
      VALUES ('capture', 'workspace', 'creator', 'recording',
       '{"guideId":"guide","revisionId":"revision","title":"Guide","expectedSteps":0,"policyVersion":"privacy-v1"}');
    UPDATE capture_sessions SET capture_scope =
       '{"guideId":"guide","revisionId":"revision","title":"Guide","expectedSteps":1,"policyVersion":"privacy-v1"}'
      WHERE id = 'capture';
    INSERT INTO guide_media
      (id, workspace_id, revision_id, capture_session_id, object_key, content_type,
       byte_size, width, height, sha256, uploaded_by)
      VALUES ('media-1', 'workspace', 'revision', 'capture',
       'workspaces/workspace/revisions/revision/one.png', 'image/png', 100, 10, 10,
       'hash-1', 'creator');
  `);
  assert.throws(
    () =>
      database.exec(
        `UPDATE capture_sessions SET capture_scope =
          '{"guideId":"guide","revisionId":"revision","title":"Guide","expectedSteps":2,"policyVersion":"privacy-v1"}'
         WHERE id = 'capture'`,
      ),
    /invalid capture scope update/i,
  );
  assert.throws(
    () =>
      database.exec(
        `INSERT INTO guide_media
          (id, workspace_id, revision_id, capture_session_id, object_key, content_type,
           byte_size, width, height, sha256, uploaded_by)
         VALUES ('media-2', 'workspace', 'revision', 'capture',
          'workspaces/workspace/revisions/revision/two.png', 'image/png', 100, 10, 10,
          'hash-2', 'creator')`,
      ),
    /capture media unavailable/i,
  );
  database.exec("UPDATE capture_sessions SET status = 'paused' WHERE id = 'capture'");
  assert.throws(
    () =>
      database.exec(
        `INSERT INTO guide_media
          (id, workspace_id, revision_id, capture_session_id, object_key, content_type,
           byte_size, width, height, sha256, uploaded_by)
         VALUES ('media-paused', 'workspace', 'revision', 'capture',
          'workspaces/workspace/revisions/revision/paused.png', 'image/png', 100, 10, 10,
          'hash-paused', 'creator')`,
      ),
    /capture media unavailable/i,
  );
  database.exec(`
    UPDATE capture_sessions SET status = 'recording' WHERE id = 'capture';
    UPDATE capture_sessions SET status = 'finished', last_sequence = 1 WHERE id = 'capture';
  `);
  assert.throws(
    () => database.exec("UPDATE capture_sessions SET status = 'recording' WHERE id = 'capture'"),
    /invalid capture status transition/i,
  );

  database.exec(`
    INSERT INTO guides
      (id, workspace_id, title, slug, author_user_id, working_draft_revision_id)
      VALUES ('discard-guide', 'workspace', 'Discard', 'discard', 'creator', 'discard-revision');
    INSERT INTO guide_revisions
      (id, guide_id, workspace_id, version, status, source_type, title, created_by)
      VALUES ('discard-revision', 'discard-guide', 'workspace', 1, 'draft', 'capture',
       'Discard', 'creator');
    INSERT INTO capture_sessions
      (id, workspace_id, user_id, status, capture_scope)
      VALUES ('discard-capture', 'workspace', 'creator', 'recording',
       '{"guideId":"discard-guide","revisionId":"discard-revision","title":"Discard","expectedSteps":0,"policyVersion":"privacy-v1"}');
  `);
  assert.throws(
    () =>
      database.exec(
        "UPDATE capture_sessions SET status = 'discarded' WHERE id = 'discard-capture'",
      ),
    /draft must be deleted/i,
  );
  database.exec(`
    DELETE FROM guides WHERE id = 'discard-guide';
    UPDATE capture_sessions SET status = 'discarded' WHERE id = 'discard-capture';
  `);
  assert.equal(
    database
      .prepare("SELECT status FROM capture_sessions WHERE id = 'discard-capture'")
      .get().status,
    "discarded",
  );
  database.close();
});

test("capture guards reject uploads and completion after the scoped draft is archived", async () => {
  const database = await openMigratedDatabase();
  database.exec(`
    INSERT INTO entities (id, name, created_by) VALUES ('entity', 'Entity', 'owner');
    INSERT INTO workspaces (id, entity_id, name, slug, created_by)
      VALUES ('workspace', 'entity', 'Workspace', 'workspace', 'owner');
    INSERT INTO workspace_members (workspace_id, user_id, email)
      VALUES ('workspace', 'creator', 'creator@example.com');
    INSERT INTO guides
      (id, workspace_id, title, slug, author_user_id, working_draft_revision_id)
      VALUES ('guide', 'workspace', 'Guide', 'guide', 'creator', 'revision');
    INSERT INTO guide_revisions
      (id, guide_id, workspace_id, version, status, source_type, title, created_by)
      VALUES ('revision', 'guide', 'workspace', 1, 'draft', 'capture', 'Guide', 'creator');
    INSERT INTO capture_sessions
      (id, workspace_id, user_id, status, capture_scope)
      VALUES ('capture', 'workspace', 'creator', 'recording',
       '{"guideId":"guide","revisionId":"revision","title":"Guide","expectedSteps":1,"policyVersion":"privacy-v1"}');
    UPDATE guides SET archived_at = CURRENT_TIMESTAMP WHERE id = 'guide';
    UPDATE guide_revisions SET status = 'archived' WHERE id = 'revision';
  `);

  assert.throws(
    () =>
      database.exec(`
        INSERT INTO guide_media
          (id, workspace_id, revision_id, capture_session_id, object_key, content_type,
           byte_size, width, height, sha256, uploaded_by)
        VALUES ('media-archived', 'workspace', 'revision', 'capture',
          'workspaces/workspace/revisions/revision/archived.png', 'image/png',
          100, 10, 10, 'hash-archived', 'creator')
      `),
    /live capture draft required/i,
  );

  database.exec(`
    UPDATE guides SET archived_at = NULL WHERE id = 'guide';
    UPDATE guide_revisions SET status = 'draft' WHERE id = 'revision';
    INSERT INTO guide_media
      (id, workspace_id, revision_id, capture_session_id, object_key, content_type,
       byte_size, width, height, sha256, uploaded_by)
      VALUES ('media-live', 'workspace', 'revision', 'capture',
        'workspaces/workspace/revisions/revision/live.png', 'image/png',
        100, 10, 10, 'hash-live', 'creator');
    UPDATE guides SET archived_at = CURRENT_TIMESTAMP WHERE id = 'guide';
    UPDATE guide_revisions SET status = 'archived' WHERE id = 'revision';
  `);

  assert.throws(
    () =>
      database.exec(
        "UPDATE capture_sessions SET status = 'finished', last_sequence = 1 WHERE id = 'capture'",
      ),
    /live capture draft required/i,
  );
  assert.equal(
    database
      .prepare("SELECT status FROM capture_sessions WHERE id = 'capture'")
      .get().status,
    "recording",
  );
  database.close();
});

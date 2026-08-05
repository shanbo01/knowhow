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
  outputDirectory = await mkdtemp(path.join(tmpdir(), "rivet-search-"));
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

// Seeds a workspace with three guides:
//  - guide "onboarding"   published to the whole workspace (visible to viewer)
//  - guide "engineering"  published, restricted to the engineers group (hidden)
//  - guide "draft-note"   private draft by an engineer (hidden)
function seedSearchWorkspace(database) {
  const exec = (sql) => database.exec(sql);
  exec(`INSERT INTO entities (id, name, status, created_by) VALUES ('entity1', 'Customer Co', 'active', 'u-admin')`);
  exec(`INSERT INTO workspaces (id, entity_id, name, slug, status, self_serve, created_by) VALUES ('w1', 'entity1', 'Customer Co', 'w1', 'active', 0, 'u-admin')`);
  exec(`INSERT INTO workspace_settings (workspace_id, accent_color, click_target_color) VALUES ('w1', '#1f7653', '#ef6f47')`);
  exec(`INSERT INTO groups (id, workspace_id, name, slug, kind, created_by) VALUES ('g-all', 'w1', 'All Employees', 'all-employees', 'all_members', 'u-admin')`);
  exec(`INSERT INTO groups (id, workspace_id, name, slug, kind, created_by) VALUES ('g-eng', 'w1', 'Engineers', 'engineers', 'custom', 'u-admin')`);
  for (const [userId, email, name, role, groupId] of [
    ["u-viewer", "viewer@customer.com", "Viewer", "viewer", "g-all"],
    ["u-engineer", "engineer@customer.com", "Engineer", "creator", "g-eng"],
  ]) {
    exec(`INSERT INTO workspace_members (workspace_id, user_id, email, display_name, status) VALUES ('w1', '${userId}', '${email}', '${name}', 'active')`);
    exec(`INSERT INTO workspace_member_roles (workspace_id, user_id, role, granted_by) VALUES ('w1', '${userId}', '${role}', 'u-admin')`);
    exec(`INSERT INTO group_members (group_id, workspace_id, user_id, added_by) VALUES ('${groupId}', 'w1', '${userId}', 'u-admin')`);
  }

  // Guide 1: workspace-published onboarding guide with a matching step.
  exec(`INSERT INTO guides (id, workspace_id, title, slug, author_user_id, current_published_revision_id, working_draft_revision_id) VALUES ('g1', 'w1', 'Employee onboarding', 'onboarding', 'u-engineer', 'r1', NULL)`);
  exec(`INSERT INTO guide_revisions (id, guide_id, workspace_id, version, status, source_type, title, summary, category, tags_json, created_by, published_by, published_at) VALUES ('r1', 'g1', 'w1', 1, 'published', 'manual', 'Employee onboarding', 'How new joiners start', 'HR', '["onboarding","hr"]', 'u-engineer', 'u-admin', CURRENT_TIMESTAMP)`);
  exec(`INSERT INTO guide_audiences (revision_id, subject_type, subject_id, granted_by) VALUES ('r1', 'workspace', 'w1', 'u-admin')`);
  exec(`INSERT INTO guide_steps (id, revision_id, position, kind, title, body) VALUES ('s1', 'r1', 0, 'action', 'Create a user', 'Create a user account in the admin console so the new joiner can sign in.')`);
  exec(`INSERT INTO guide_steps (id, revision_id, position, kind, title, body) VALUES ('s2', 'r1', 1, 'action', 'Assign licenses', 'Assign the standard license set from the billing portal.')`);

  // Guide 2: published but restricted to the engineers group only.
  exec(`INSERT INTO guides (id, workspace_id, title, slug, author_user_id, current_published_revision_id, working_draft_revision_id) VALUES ('g2', 'w1', 'Engineers secret runbook', 'engineers-secret', 'u-engineer', 'r2', NULL)`);
  exec(`INSERT INTO guide_revisions (id, guide_id, workspace_id, version, status, source_type, title, summary, category, tags_json, created_by, published_by, published_at) VALUES ('r2', 'g2', 'w1', 1, 'published', 'manual', 'Engineers secret runbook', 'Recovery steps only for engineers', 'SRE', '["sre","secret"]', 'u-engineer', 'u-admin', CURRENT_TIMESTAMP)`);
  exec(`INSERT INTO guide_audiences (revision_id, subject_type, subject_id, granted_by) VALUES ('r2', 'group', 'g-eng', 'u-admin')`);
  exec(`INSERT INTO guide_steps (id, revision_id, position, kind, title, body) VALUES ('s3', 'r2', 0, 'action', 'Recover vault', 'Engineers secret vault recovery procedure.')`);

  // Guide 3: a private draft by the engineer, invisible to the viewer.
  exec(`INSERT INTO guides (id, workspace_id, title, slug, author_user_id, current_published_revision_id, working_draft_revision_id) VALUES ('g3', 'w1', 'Draft note', 'draft-note', 'u-engineer', NULL, 'r3')`);
  exec(`INSERT INTO guide_revisions (id, guide_id, workspace_id, version, status, source_type, title, summary, category, tags_json, created_by) VALUES ('r3', 'g3', 'w1', 1, 'draft', 'manual', 'Draft note', 'Unpublished thought about vendor pricing', 'Finance', '[]', 'u-engineer')`);
  exec(`INSERT INTO guide_steps (id, revision_id, position, kind, title, body) VALUES ('s4', 'r3', 0, 'note', 'Idea', 'Consider negotiating the vendor contract in Q3.')`);
}

const identity = {
  userId: "u-viewer",
  email: "viewer@customer.com",
  name: "Viewer",
  emailVerified: true,
  labels: [],
};

test("search returns only guides the viewer is authorized to read", async () => {
  const database = await openMigratedDatabase();
  seedSearchWorkspace(database);
  const repository = new access.D1RivetRepository(d1Adapter(database));
  const viewerAccess = await repository.getWorkspaceAccess("w1", "u-viewer");
  assert.ok(viewerAccess);
  assert.ok(viewerAccess.groupIds.includes("g-all"), "viewer belongs to all-members group");
  assert.ok(!viewerAccess.groupIds.includes("g-eng"), "viewer is not in the engineers group");

  const results = await access.searchGuides(
    d1Adapter(database),
    viewerAccess,
    identity,
    false,
    "create a user",
  );
  assert.equal(results.length, 1, "only the authorized onboarding guide should match");
  assert.equal(results[0].guideId, "g1");
  assert.equal(results[0].title, "Employee onboarding");
  assert.equal(results[0].status, "published");
  assert.equal(results[0].restricted, false);
  assert.ok(
    results[0].excerpt.toLowerCase().includes("create a user"),
    "the excerpt should come from the matching step text",
  );
});

test("restricted and private content never surfaces — not even existence", async () => {
  const database = await openMigratedDatabase();
  seedSearchWorkspace(database);
  const repository = new access.D1RivetRepository(d1Adapter(database));
  const viewerAccess = await repository.getWorkspaceAccess("w1", "u-viewer");

  // A search targeting the restricted guide's unique words must return nothing.
  const restricted = await access.searchGuides(
    d1Adapter(database),
    viewerAccess,
    identity,
    false,
    "engineers secret recovery",
  );
  assert.equal(restricted.length, 0, "restricted-guide metadata must not leak");

  // A search targeting the private draft's unique words must return nothing.
  const draft = await access.searchGuides(
    d1Adapter(database),
    viewerAccess,
    identity,
    false,
    "vendor pricing negotiation",
  );
  assert.equal(draft.length, 0, "private draft content must not leak");

  // The workspace-audience guide still matches for a broader query.
  const broad = await access.searchGuides(
    d1Adapter(database),
    viewerAccess,
    identity,
    false,
    "create",
  );
  assert.deepEqual(
    broad.map((item) => item.guideId),
    ["g1"],
    "only the workspace-published guide is visible",
  );
});

test("the engineers group member sees the restricted guide", async () => {
  const database = await openMigratedDatabase();
  seedSearchWorkspace(database);
  const repository = new access.D1RivetRepository(d1Adapter(database));
  const engineerAccess = await repository.getWorkspaceAccess("w1", "u-engineer");
  assert.ok(engineerAccess.groupIds.includes("g-eng"));

  const results = await access.searchGuides(
    d1Adapter(database),
    engineerAccess,
    { ...identity, userId: "u-engineer", email: "engineer@customer.com", name: "Engineer" },
    false,
    "engineers secret",
  );
  assert.deepEqual(
    results.map((item) => item.guideId),
    ["g2"],
  );
  assert.equal(results[0].restricted, true);
});

test("workspace boundaries hold: a member of another workspace finds nothing", async () => {
  const database = await openMigratedDatabase();
  seedSearchWorkspace(database);
  database.exec(`INSERT INTO entities (id, name, status, created_by) VALUES ('entity2', 'Other Co', 'active', 'u-admin')`);
  database.exec(`INSERT INTO workspaces (id, entity_id, name, slug, status, self_serve, created_by) VALUES ('w2', 'entity2', 'Other Co', 'w2', 'active', 0, 'u-admin')`);
  database.exec(`INSERT INTO workspace_settings (workspace_id, accent_color, click_target_color) VALUES ('w2', '#1f7653', '#ef6f47')`);
  database.exec(`INSERT INTO workspace_members (workspace_id, user_id, email, display_name, status) VALUES ('w2', 'u-viewer', 'viewer@customer.com', 'Viewer', 'active')`);
  database.exec(`INSERT INTO workspace_member_roles (workspace_id, user_id, role, granted_by) VALUES ('w2', 'u-viewer', 'viewer', 'u-admin')`);

  const repository = new access.D1RivetRepository(d1Adapter(database));
  const otherAccess = await repository.getWorkspaceAccess("w2", "u-viewer");
  const results = await access.searchGuides(
    d1Adapter(database),
    otherAccess,
    identity,
    false,
    "create a user",
  );
  assert.equal(results.length, 0, "search is scoped to the requested workspace only");
});

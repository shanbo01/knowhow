CREATE TABLE `admin_appointments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` text NOT NULL,
	`created_by` text NOT NULL,
	`accepted_by` text,
	`accepted_at` text,
	`revoked_by` text,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "admin_appointments_status_check" CHECK("admin_appointments"."status" IN ('active', 'accepted', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_admin_appointments_token_hash` ON `admin_appointments` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_admin_appointments_workspace_status` ON `admin_appointments` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `platform_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `support_access_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`approved_by` text NOT NULL,
	`granted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text NOT NULL,
	`ended_at` text,
	`revoked_by` text,
	FOREIGN KEY (`request_id`) REFERENCES `support_access_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "support_access_grants_status_check" CHECK("support_access_grants"."status" IN ('active', 'expired', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_support_access_grants_request` ON `support_access_grants` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_support_access_grants_workspace_user` ON `support_access_grants` (`workspace_id`,`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_support_access_grants_expiry` ON `support_access_grants` (`expires_at`);--> statement-breakpoint
CREATE TABLE `support_access_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`requester_user_id` text NOT NULL,
	`requester_email` text NOT NULL,
	`requester_name` text NOT NULL,
	`requested_role` text NOT NULL,
	`reason` text NOT NULL,
	`requested_duration_hours` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`granted_role` text,
	`grant_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "support_access_requests_status_check" CHECK("support_access_requests"."status" IN ('pending', 'approved', 'denied', 'cancelled')),
	CONSTRAINT "support_access_requests_duration_check" CHECK("support_access_requests"."requested_duration_hours" BETWEEN 1 AND 168),
	CONSTRAINT "support_access_requests_reason_check" CHECK(length("support_access_requests"."reason") BETWEEN 10 AND 2000)
);
--> statement-breakpoint
CREATE INDEX `idx_support_access_requests_workspace_status` ON `support_access_requests` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
DROP TRIGGER IF EXISTS `invite_redemptions_validate_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `invite_redemptions_increment_use`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text DEFAULT 'Invite link' NOT NULL,
	`email` text,
	`role` text DEFAULT 'viewer' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`max_uses` integer DEFAULT 1 NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_via` text DEFAULT 'standard' NOT NULL,
	`revoked_by` text,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invitations_role_check" CHECK("__new_invitations"."role" IN ('creator', 'reviewer', 'publisher', 'viewer')),
	CONSTRAINT "invitations_created_via_check" CHECK("__new_invitations"."created_via" IN ('standard', 'support-access')),
	CONSTRAINT "invitations_status_check" CHECK("__new_invitations"."status" IN ('active', 'revoked', 'exhausted')),
	CONSTRAINT "invitations_uses_check" CHECK("__new_invitations"."max_uses" > 0 AND "__new_invitations"."use_count" >= 0 AND "__new_invitations"."use_count" <= "__new_invitations"."max_uses")
);
--> statement-breakpoint
INSERT INTO `__new_invitations`("id", "workspace_id", "token_hash", "label", "email", "role", "status", "max_uses", "use_count", "expires_at", "created_by", "created_via", "revoked_by", "revoked_at", "created_at") SELECT "id", "workspace_id", "token_hash", "label", "email", "role", "status", "max_uses", "use_count", "expires_at", "created_by", 'standard', "revoked_by", "revoked_at", "created_at" FROM `invitations`;--> statement-breakpoint
DROP TABLE `invitations`;--> statement-breakpoint
ALTER TABLE `__new_invitations` RENAME TO `invitations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_invitations_token_hash` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_invitations_workspace_status_expiry` ON `invitations` (`workspace_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS invite_redemptions_validate_insert
BEFORE INSERT ON invite_redemptions
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM invitations i
      JOIN workspaces w ON w.id = i.workspace_id
      WHERE i.id = NEW.invitation_id
        AND i.status = 'active'
        AND i.use_count < i.max_uses
        AND unixepoch(i.expires_at) > unixepoch('now')
        AND w.status = 'active'
        AND (i.email IS NULL OR lower(i.email) = lower(NEW.email))
    )
    THEN RAISE(ABORT, 'invitation unavailable')
  END;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS invite_redemptions_increment_use
AFTER INSERT ON invite_redemptions
BEGIN
  UPDATE invitations
  SET use_count = use_count + 1,
      status = CASE
        WHEN use_count + 1 >= max_uses THEN 'exhausted'
        ELSE status
      END
  WHERE id = NEW.invitation_id;
  SELECT CASE
    WHEN changes() != 1
    THEN RAISE(ABORT, 'invitation redemption failed')
  END;
END;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `self_serve` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `platform_settings` ("key", "value_json", "updated_by", "updated_at") VALUES ('selfServiceWorkspaceLimit', '1', 'system', CURRENT_TIMESTAMP);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS workspaces_limit_self_serve
BEFORE INSERT ON workspaces
WHEN NEW.self_serve = 1
BEGIN
  SELECT CASE
    WHEN (
      SELECT COUNT(*)
      FROM workspaces
      WHERE created_by = NEW.created_by AND self_serve = 1
    ) >= CAST(COALESCE(
      (
        SELECT json_extract(value_json, '$')
        FROM platform_settings
        WHERE key = 'selfServiceWorkspaceLimit'
      ),
      1
    ) AS INTEGER)
    THEN RAISE(ABORT, 'self-serve workspace limit reached')
  END;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS support_access_requests_validate_decision
BEFORE UPDATE OF status ON support_access_requests
WHEN NEW.status != OLD.status
BEGIN
  SELECT CASE
    WHEN OLD.status != 'pending'
      OR NEW.status NOT IN ('approved', 'denied', 'cancelled')
      OR NEW.decided_by IS NULL
      OR NEW.decided_at IS NULL
      OR (
        NEW.status = 'approved'
        AND (NEW.granted_role IS NULL OR NEW.grant_id IS NULL)
      )
      OR (NEW.status = 'approved' AND NEW.decided_by = NEW.requester_user_id)
    THEN RAISE(ABORT, 'invalid support request decision')
  END;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS support_access_grants_validate_insert
BEFORE INSERT ON support_access_grants
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM support_access_requests r
      WHERE r.id = NEW.request_id
        AND r.workspace_id = NEW.workspace_id
        AND r.status = 'approved'
        AND r.requester_user_id = NEW.user_id
        AND r.decided_by IS NOT NULL
        AND r.decided_by != r.requester_user_id
    )
    THEN RAISE(ABORT, 'support grant requires an approved request')
  END;
  SELECT CASE
    WHEN NEW.approved_by IS NULL OR NEW.approved_by = NEW.user_id
    THEN RAISE(ABORT, 'support grant cannot be self-approved')
  END;
  SELECT CASE
    WHEN unixepoch(NEW.expires_at) <= unixepoch('now')
    THEN RAISE(ABORT, 'support grant is already expired')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM support_access_grants g
      WHERE g.workspace_id = NEW.workspace_id
        AND g.user_id = NEW.user_id
        AND g.status = 'active'
    )
    THEN RAISE(ABORT, 'an active support grant already exists')
  END;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS support_access_grants_validate_update
BEFORE UPDATE OF status ON support_access_grants
WHEN NEW.status != OLD.status
BEGIN
  SELECT CASE
    WHEN OLD.status != 'active'
      OR NEW.status NOT IN ('expired', 'revoked')
      OR NEW.ended_at IS NULL
      OR (NEW.status = 'revoked' AND NEW.revoked_by IS NULL)
    THEN RAISE(ABORT, 'invalid support grant transition')
  END;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS admin_appointments_single_accept
BEFORE UPDATE OF accepted_by ON admin_appointments
WHEN NEW.accepted_by IS NOT NULL
  AND (OLD.accepted_by IS NULL OR NEW.accepted_by != OLD.accepted_by)
BEGIN
  SELECT CASE
    WHEN OLD.status != 'active'
      OR unixepoch(OLD.expires_at) <= unixepoch('now')
      OR NOT EXISTS (
        SELECT 1
        FROM workspace_members wm
        WHERE wm.workspace_id = OLD.workspace_id
          AND wm.user_id = NEW.accepted_by
          AND wm.status = 'active'
          AND lower(wm.email) = lower(OLD.email)
      )
    THEN RAISE(ABORT, 'appointment unavailable')
  END;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS admin_appointments_status_transitions
BEFORE UPDATE OF status ON admin_appointments
WHEN NEW.status != OLD.status
BEGIN
  SELECT CASE
    WHEN NOT (
      OLD.status = 'active'
      AND NEW.status IN ('accepted', 'revoked', 'expired')
    )
    THEN RAISE(ABORT, 'invalid appointment transition')
  END;
  SELECT CASE
    WHEN NEW.status = 'accepted'
      AND (NEW.accepted_by IS NULL OR NEW.accepted_at IS NULL)
    THEN RAISE(ABORT, 'appointment acceptance incomplete')
  END;
  SELECT CASE
    WHEN NEW.status = 'revoked'
      AND (NEW.revoked_by IS NULL OR NEW.revoked_at IS NULL)
    THEN RAISE(ABORT, 'appointment revocation incomplete')
  END;
END;
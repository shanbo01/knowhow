CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`previous_hash` text NOT NULL,
	`event_hash` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_email` text,
	`actor_name` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`target_label` text,
	`summary` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "audit_events_sequence_check" CHECK("audit_events"."sequence" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_audit_events_workspace_sequence` ON `audit_events` (`workspace_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_audit_events_workspace_hash` ON `audit_events` (`workspace_id`,`event_hash`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_workspace_occurred` ON `audit_events` (`workspace_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_workspace_action` ON `audit_events` (`workspace_id`,`action`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `audit_heads` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`last_sequence` integer DEFAULT 0 NOT NULL,
	`last_hash` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `capture_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`device_token_id` text,
	`status` text DEFAULT 'recording' NOT NULL,
	`last_sequence` integer DEFAULT 0 NOT NULL,
	`capture_scope` text NOT NULL,
	`excluded_origin` text,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`paused_at` text,
	`finished_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`user_id`) REFERENCES `workspace_members`(`workspace_id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "capture_sessions_status_check" CHECK("capture_sessions"."status" IN ('recording', 'paused', 'finished', 'discarded')),
	CONSTRAINT "capture_sessions_sequence_check" CHECK("capture_sessions"."last_sequence" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_capture_sessions_workspace_user_status` ON `capture_sessions` (`workspace_id`,`user_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_capture_sessions_id_workspace` ON `capture_sessions` (`id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `device_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes_json` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`last_used_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`user_id`) REFERENCES `workspace_members`(`workspace_id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_device_tokens_hash` ON `device_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_device_tokens_workspace_user` ON `device_tokens` (`workspace_id`,`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "entities_status_check" CHECK("entities"."status" IN ('active', 'suspended', 'archived'))
);
--> statement-breakpoint
CREATE INDEX `idx_entities_status` ON `entities` (`status`);--> statement-breakpoint
CREATE TABLE `exports` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`format` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`object_key` text,
	`watermarked` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`error_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`) REFERENCES `guide_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`,`workspace_id`) REFERENCES `guide_revisions`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "exports_format_check" CHECK("exports"."format" IN ('pdf', 'html', 'markdown')),
	CONSTRAINT "exports_status_check" CHECK("exports"."status" IN ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_exports_workspace_created` ON `exports` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`,`workspace_id`) REFERENCES `groups`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`user_id`) REFERENCES `workspace_members`(`workspace_id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_group_members_user_group` ON `group_members` (`user_id`,`group_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`sensitive` integer DEFAULT false NOT NULL,
	`kind` text DEFAULT 'custom' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "groups_kind_check" CHECK("groups"."kind" IN ('all_members', 'custom'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_groups_workspace_slug` ON `groups` (`workspace_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_groups_id_workspace` ON `groups` (`id`,`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_groups_workspace_all_members` ON `groups` (`workspace_id`) WHERE "groups"."kind" = 'all_members';--> statement-breakpoint
CREATE INDEX `idx_groups_workspace_kind` ON `groups` (`workspace_id`,`kind`);--> statement-breakpoint
CREATE TABLE `guide_audiences` (
	`revision_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`revision_id`, `subject_type`, `subject_id`),
	FOREIGN KEY (`revision_id`) REFERENCES `guide_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "guide_audiences_subject_type_check" CHECK("guide_audiences"."subject_type" IN ('workspace', 'group', 'user'))
);
--> statement-breakpoint
CREATE INDEX `idx_guide_audiences_subject` ON `guide_audiences` (`subject_type`,`subject_id`,`revision_id`);--> statement-breakpoint
CREATE TABLE `guide_media` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`step_id` text,
	`capture_session_id` text,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`sha256` text NOT NULL,
	`redaction_state` text DEFAULT 'redacted' NOT NULL,
	`source_rasterized` integer DEFAULT true NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`) REFERENCES `guide_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `guide_steps`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`capture_session_id`) REFERENCES `capture_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`revision_id`,`workspace_id`) REFERENCES `guide_revisions`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`,`revision_id`) REFERENCES `guide_steps`(`id`,`revision_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`capture_session_id`,`workspace_id`) REFERENCES `capture_sessions`(`id`,`workspace_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "guide_media_content_type_check" CHECK("guide_media"."content_type" IN ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "guide_media_redaction_check" CHECK("guide_media"."redaction_state" = 'redacted' AND "guide_media"."source_rasterized" = 1),
	CONSTRAINT "guide_media_dimensions_check" CHECK("guide_media"."byte_size" > 0 AND "guide_media"."width" > 0 AND "guide_media"."height" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_guide_media_object_key` ON `guide_media` (`object_key`);--> statement-breakpoint
CREATE INDEX `idx_guide_media_revision_step` ON `guide_media` (`revision_id`,`step_id`);--> statement-breakpoint
CREATE INDEX `idx_guide_media_workspace_created` ON `guide_media` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `guide_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`guide_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`source_type` text DEFAULT 'manual' NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`category` text,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`system_references_json` text DEFAULT '[]' NOT NULL,
	`privacy_reviewed_at` text,
	`privacy_reviewed_by` text,
	`created_by` text NOT NULL,
	`submitted_at` text,
	`published_by` text,
	`published_at` text,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`guide_id`) REFERENCES `guides`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guide_id`,`workspace_id`) REFERENCES `guides`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "guide_revisions_version_check" CHECK("guide_revisions"."version" > 0),
	CONSTRAINT "guide_revisions_status_check" CHECK("guide_revisions"."status" IN ('draft', 'review', 'published', 'archived')),
	CONSTRAINT "guide_revisions_source_check" CHECK("guide_revisions"."source_type" IN ('manual', 'capture', 'import'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_guide_revisions_guide_version` ON `guide_revisions` (`guide_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_guide_revisions_id_workspace` ON `guide_revisions` (`id`,`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_guide_revisions_workspace_status` ON `guide_revisions` (`workspace_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_guide_revisions_guide_status` ON `guide_revisions` (`guide_id`,`status`);--> statement-breakpoint
CREATE TABLE `guide_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`revision_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text DEFAULT 'action' NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`expected_result` text,
	`requires_confirmation` integer DEFAULT false NOT NULL,
	`annotation_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `guide_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "guide_steps_position_check" CHECK("guide_steps"."position" >= 0),
	CONSTRAINT "guide_steps_kind_check" CHECK("guide_steps"."kind" IN ('action', 'heading', 'note', 'warning'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_guide_steps_revision_position` ON `guide_steps` (`revision_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_guide_steps_id_revision` ON `guide_steps` (`id`,`revision_id`);--> statement-breakpoint
CREATE TABLE `guides` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`author_user_id` text NOT NULL,
	`current_published_revision_id` text,
	`working_draft_revision_id` text,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_guides_workspace_slug` ON `guides` (`workspace_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_guides_id_workspace` ON `guides` (`id`,`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_guides_workspace_updated` ON `guides` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_guides_workspace_archived` ON `guides` (`workspace_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `invitations` (
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
	`revoked_by` text,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invitations_role_check" CHECK("invitations"."role" IN ('creator', 'reviewer', 'publisher', 'viewer')),
	CONSTRAINT "invitations_status_check" CHECK("invitations"."status" IN ('active', 'revoked', 'exhausted')),
	CONSTRAINT "invitations_uses_check" CHECK("invitations"."max_uses" > 0 AND "invitations"."use_count" >= 0 AND "invitations"."use_count" <= "invitations"."max_uses")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_invitations_token_hash` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_invitations_workspace_status_expiry` ON `invitations` (`workspace_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `invite_redemptions` (
	`invitation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`redeemed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`invitation_id`, `user_id`),
	FOREIGN KEY (`invitation_id`) REFERENCES `invitations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_invite_redemptions_user` ON `invite_redemptions` (`user_id`,`redeemed_at`);--> statement-breakpoint
CREATE TABLE `join_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "join_requests_status_check" CHECK("join_requests"."status" IN ('pending', 'approved', 'denied'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_join_requests_workspace_user` ON `join_requests` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_join_requests_workspace_status` ON `join_requests` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `platform_admins` (
	`user_id` text PRIMARY KEY NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_assignments` (
	`revision_id` text NOT NULL,
	`reviewer_user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`note` text,
	`assigned_by` text NOT NULL,
	`assigned_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`decided_at` text,
	PRIMARY KEY(`revision_id`, `reviewer_user_id`),
	FOREIGN KEY (`revision_id`) REFERENCES `guide_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "review_assignments_status_check" CHECK("review_assignments"."status" IN ('pending', 'approved', 'changes_requested'))
);
--> statement-breakpoint
CREATE INDEX `idx_review_assignments_reviewer_status` ON `review_assignments` (`reviewer_user_id`,`status`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vault_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`encrypted_envelope_json` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_vault_items_workspace_updated` ON `vault_items` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `workspace_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`domain_ascii` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workspace_domains_workspace_domain` ON `workspace_domains` (`workspace_id`,`domain_ascii`);--> statement-breakpoint
CREATE INDEX `idx_workspace_domains_domain_enabled` ON `workspace_domains` (`domain_ascii`,`enabled`);--> statement-breakpoint
CREATE TABLE `workspace_member_capabilities` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`capability` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`, `capability`),
	FOREIGN KEY (`workspace_id`,`user_id`) REFERENCES `workspace_members`(`workspace_id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_member_capabilities_check" CHECK("workspace_member_capabilities"."capability" = 'vault')
);
--> statement-breakpoint
CREATE TABLE `workspace_member_roles` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`, `role`),
	FOREIGN KEY (`workspace_id`,`user_id`) REFERENCES `workspace_members`(`workspace_id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_member_roles_role_check" CHECK("workspace_member_roles"."role" IN ('administrator', 'creator', 'reviewer', 'publisher', 'viewer'))
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_member_roles_user` ON `workspace_member_roles` (`user_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`status` text DEFAULT 'active' NOT NULL,
	`joined_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_members_status_check" CHECK("workspace_members"."status" IN ('active', 'suspended'))
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_members_user_status` ON `workspace_members` (`user_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workspace_members_workspace_email` ON `workspace_members` (`workspace_id`,`email`);--> statement-breakpoint
CREATE TABLE `workspace_metrics_daily` (
	`workspace_id` text NOT NULL,
	`metric_date` text NOT NULL,
	`drafts` integer DEFAULT 0 NOT NULL,
	`published_guides` integer DEFAULT 0 NOT NULL,
	`captures` integer DEFAULT 0 NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`completions` integer DEFAULT 0 NOT NULL,
	`exports` integer DEFAULT 0 NOT NULL,
	`storage_bytes` integer DEFAULT 0 NOT NULL,
	`failed_operations` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`workspace_id`, `metric_date`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_metrics_date` ON `workspace_metrics_daily` (`metric_date`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `workspace_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`logo_object_key` text,
	`accent_color` text DEFAULT '#2563eb' NOT NULL,
	`click_target_color` text DEFAULT '#ef4444' NOT NULL,
	`remove_branding` integer DEFAULT false NOT NULL,
	`restricted_exports_enabled` integer DEFAULT false NOT NULL,
	`watermark_restricted_exports` integer DEFAULT true NOT NULL,
	`capture_policy_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspaces_status_check" CHECK("workspaces"."status" IN ('active', 'suspended', 'archived'))
);
--> statement-breakpoint
CREATE INDEX `idx_workspaces_entity_status` ON `workspaces` (`entity_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workspaces_entity_slug` ON `workspaces` (`entity_id`,`slug`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_events_validate_chain
BEFORE INSERT ON audit_events
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM audit_heads WHERE workspace_id = NEW.workspace_id
    )
    THEN RAISE(ABORT, 'audit head missing')
  END;
  SELECT CASE
    WHEN NEW.sequence != (
      SELECT last_sequence + 1
      FROM audit_heads
      WHERE workspace_id = NEW.workspace_id
    )
    THEN RAISE(ABORT, 'audit sequence mismatch')
  END;
  SELECT CASE
    WHEN NEW.previous_hash != (
      SELECT CASE
        WHEN last_hash = '' THEN '0000000000000000000000000000000000000000000000000000000000000000'
        ELSE last_hash
      END
      FROM audit_heads
      WHERE workspace_id = NEW.workspace_id
    )
    THEN RAISE(ABORT, 'audit previous hash mismatch')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_events_advance_head
AFTER INSERT ON audit_events
BEGIN
  UPDATE audit_heads
  SET last_sequence = NEW.sequence,
      last_hash = NEW.event_hash,
      updated_at = NEW.occurred_at
  WHERE workspace_id = NEW.workspace_id
    AND last_sequence = NEW.sequence - 1
    AND (CASE WHEN last_hash = '' THEN '0000000000000000000000000000000000000000000000000000000000000000' ELSE last_hash END) = NEW.previous_hash;
  SELECT CASE
    WHEN changes() != 1
    THEN RAISE(ABORT, 'audit head advance failed')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_events_reject_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_events_reject_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS guide_audiences_validate_insert
BEFORE INSERT ON guide_audiences
BEGIN
  SELECT CASE
    WHEN NEW.subject_type = 'workspace'
      AND NEW.subject_id != (
        SELECT workspace_id FROM guide_revisions WHERE id = NEW.revision_id
      )
    THEN RAISE(ABORT, 'audience workspace mismatch')
    WHEN NEW.subject_type = 'group'
      AND NOT EXISTS (
        SELECT 1
        FROM groups g
        JOIN guide_revisions r ON r.id = NEW.revision_id
        WHERE g.id = NEW.subject_id AND g.workspace_id = r.workspace_id
      )
    THEN RAISE(ABORT, 'audience group workspace mismatch')
    WHEN NEW.subject_type = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM workspace_members wm
        JOIN guide_revisions r ON r.id = NEW.revision_id
        WHERE wm.user_id = NEW.subject_id AND wm.workspace_id = r.workspace_id
      )
    THEN RAISE(ABORT, 'audience user workspace mismatch')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS guide_audiences_validate_update
BEFORE UPDATE ON guide_audiences
BEGIN
  SELECT CASE
    WHEN NEW.subject_type = 'workspace'
      AND NEW.subject_id != (
        SELECT workspace_id FROM guide_revisions WHERE id = NEW.revision_id
      )
    THEN RAISE(ABORT, 'audience workspace mismatch')
    WHEN NEW.subject_type = 'group'
      AND NOT EXISTS (
        SELECT 1
        FROM groups g
        JOIN guide_revisions r ON r.id = NEW.revision_id
        WHERE g.id = NEW.subject_id AND g.workspace_id = r.workspace_id
      )
    THEN RAISE(ABORT, 'audience group workspace mismatch')
    WHEN NEW.subject_type = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM workspace_members wm
        JOIN guide_revisions r ON r.id = NEW.revision_id
        WHERE wm.user_id = NEW.subject_id AND wm.workspace_id = r.workspace_id
      )
    THEN RAISE(ABORT, 'audience user workspace mismatch')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS review_assignments_validate_insert
BEFORE INSERT ON review_assignments
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM workspace_members wm
      JOIN guide_revisions r ON r.id = NEW.revision_id
      WHERE wm.user_id = NEW.reviewer_user_id
        AND wm.workspace_id = r.workspace_id
    )
    THEN RAISE(ABORT, 'reviewer workspace mismatch')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS review_assignments_validate_update
BEFORE UPDATE ON review_assignments
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM workspace_members wm
      JOIN guide_revisions r ON r.id = NEW.revision_id
      WHERE wm.user_id = NEW.reviewer_user_id
        AND wm.workspace_id = r.workspace_id
    )
    THEN RAISE(ABORT, 'reviewer workspace mismatch')
  END;
END;
--> statement-breakpoint
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
END;
--> statement-breakpoint
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
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS guides_validate_publish_pointer
BEFORE UPDATE OF current_published_revision_id ON guides
WHEN NEW.current_published_revision_id IS NOT OLD.current_published_revision_id
BEGIN
  SELECT CASE
    WHEN NEW.current_published_revision_id IS NULL
      OR OLD.working_draft_revision_id IS NULL
      OR NEW.current_published_revision_id != OLD.working_draft_revision_id
      OR NEW.working_draft_revision_id IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM guide_revisions r
        WHERE r.id = NEW.current_published_revision_id
          AND r.guide_id = OLD.id
          AND r.workspace_id = OLD.workspace_id
          AND r.status = 'published'
      )
    THEN RAISE(ABORT, 'invalid guide publish transition')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS guide_revisions_validate_publish
BEFORE UPDATE OF status ON guide_revisions
WHEN NEW.status = 'published'
BEGIN
  SELECT CASE
    WHEN OLD.status != 'review'
      OR NOT EXISTS (
        SELECT 1 FROM review_assignments ra
        WHERE ra.revision_id = OLD.id AND ra.status = 'approved'
      )
      OR EXISTS (
        SELECT 1 FROM review_assignments ra
        WHERE ra.revision_id = OLD.id AND ra.status != 'approved'
      )
      OR (OLD.source_type = 'capture' AND OLD.privacy_reviewed_at IS NULL)
    THEN RAISE(ABORT, 'revision is not publishable')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS device_pairing_code_single_use
BEFORE UPDATE OF device_id, token_hash ON device_tokens
WHEN OLD.device_id LIKE 'pair:%'
BEGIN
  SELECT CASE
    WHEN unixepoch(OLD.expires_at) <= unixepoch('now')
      OR NEW.device_id LIKE 'pair:%'
      OR NEW.token_hash = OLD.token_hash
    THEN RAISE(ABORT, 'pairing code unavailable')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS device_pairing_reject_rebind
BEFORE UPDATE OF device_id, token_hash ON device_tokens
WHEN OLD.device_id NOT LIKE 'pair:%'
  AND (NEW.device_id != OLD.device_id OR NEW.token_hash != OLD.token_hash)
BEGIN
  SELECT RAISE(ABORT, 'device token cannot be rebound');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS workspace_roles_keep_last_active_admin
BEFORE DELETE ON workspace_member_roles
WHEN OLD.role = 'administrator'
  AND EXISTS (
    SELECT 1 FROM workspace_members m
    WHERE m.workspace_id = OLD.workspace_id
      AND m.user_id = OLD.user_id
      AND m.status = 'active'
  )
  AND (
    SELECT COUNT(*)
    FROM workspace_member_roles r
    JOIN workspace_members m
      ON m.workspace_id = r.workspace_id AND m.user_id = r.user_id
    WHERE r.workspace_id = OLD.workspace_id
      AND r.role = 'administrator'
      AND m.status = 'active'
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'last active administrator required');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS workspace_members_keep_last_active_admin
BEFORE UPDATE OF status ON workspace_members
WHEN OLD.status = 'active' AND NEW.status != 'active'
  AND EXISTS (
    SELECT 1 FROM workspace_member_roles r
    WHERE r.workspace_id = OLD.workspace_id
      AND r.user_id = OLD.user_id
      AND r.role = 'administrator'
  )
  AND (
    SELECT COUNT(*)
    FROM workspace_member_roles r
    JOIN workspace_members m
      ON m.workspace_id = r.workspace_id AND m.user_id = r.user_id
    WHERE r.workspace_id = OLD.workspace_id
      AND r.role = 'administrator'
      AND m.status = 'active'
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'last active administrator required');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS capture_sessions_validate_status_transition
BEFORE UPDATE OF status ON capture_sessions
WHEN NEW.status != OLD.status
BEGIN
  SELECT CASE
    WHEN NOT (
      (OLD.status = 'recording' AND NEW.status IN ('paused', 'finished', 'discarded'))
      OR (OLD.status = 'paused' AND NEW.status IN ('recording', 'discarded'))
    )
    THEN RAISE(ABORT, 'invalid capture status transition')
  END;
  SELECT CASE
    WHEN NEW.status = 'discarded'
      AND EXISTS (
        SELECT 1 FROM guides g
        WHERE g.id = json_extract(NEW.capture_scope, '$.guideId')
          AND g.workspace_id = NEW.workspace_id
      )
    THEN RAISE(ABORT, 'capture draft must be deleted before discard')
  END;
  SELECT CASE
    WHEN NEW.status = 'finished'
      AND (
        json_type(NEW.capture_scope, '$.expectedSteps') != 'integer'
        OR json_extract(NEW.capture_scope, '$.expectedSteps') < 1
        OR NEW.last_sequence != json_extract(NEW.capture_scope, '$.expectedSteps')
        OR (
          SELECT COUNT(*) FROM guide_media m
          WHERE m.capture_session_id = OLD.id
            AND m.workspace_id = OLD.workspace_id
            AND m.revision_id = json_extract(OLD.capture_scope, '$.revisionId')
        ) != json_extract(NEW.capture_scope, '$.expectedSteps')
      )
    THEN RAISE(ABORT, 'capture is incomplete')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS capture_sessions_validate_scope_update
BEFORE UPDATE OF capture_scope ON capture_sessions
BEGIN
  SELECT CASE
    WHEN OLD.status NOT IN ('recording', 'paused')
      OR json_extract(NEW.capture_scope, '$.guideId') IS NOT json_extract(OLD.capture_scope, '$.guideId')
      OR json_extract(NEW.capture_scope, '$.revisionId') IS NOT json_extract(OLD.capture_scope, '$.revisionId')
      OR json_extract(NEW.capture_scope, '$.title') IS NOT json_extract(OLD.capture_scope, '$.title')
      OR json_extract(NEW.capture_scope, '$.policyVersion') IS NOT json_extract(OLD.capture_scope, '$.policyVersion')
      OR json_type(NEW.capture_scope, '$.expectedSteps') != 'integer'
      OR json_extract(NEW.capture_scope, '$.expectedSteps') NOT BETWEEN 0 AND 100
      OR (
        json_extract(NEW.capture_scope, '$.expectedSteps') != json_extract(OLD.capture_scope, '$.expectedSteps')
        AND EXISTS (
          SELECT 1 FROM guide_media m
          WHERE m.capture_session_id = OLD.id AND m.workspace_id = OLD.workspace_id
        )
      )
    THEN RAISE(ABORT, 'invalid capture scope update')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS guide_media_validate_capture_insert
BEFORE INSERT ON guide_media
WHEN NEW.capture_session_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM capture_sessions c
      WHERE c.id = NEW.capture_session_id
        AND c.workspace_id = NEW.workspace_id
        AND c.status = 'recording'
        AND c.user_id = NEW.uploaded_by
        AND json_extract(c.capture_scope, '$.revisionId') = NEW.revision_id
        AND json_type(c.capture_scope, '$.expectedSteps') = 'integer'
        AND json_extract(c.capture_scope, '$.expectedSteps') BETWEEN 1 AND 100
        AND (
          SELECT COUNT(*) FROM guide_media existing
          WHERE existing.capture_session_id = c.id
            AND existing.workspace_id = c.workspace_id
            AND existing.revision_id = NEW.revision_id
        ) < json_extract(c.capture_scope, '$.expectedSteps')
    )
    THEN RAISE(ABORT, 'capture media unavailable')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS capture_sessions_require_live_draft_on_finish
BEFORE UPDATE OF status ON capture_sessions
WHEN NEW.status = 'finished' AND OLD.status != 'finished'
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM guide_revisions r
      JOIN guides g
        ON g.id = r.guide_id AND g.workspace_id = r.workspace_id
      WHERE r.id = json_extract(NEW.capture_scope, '$.revisionId')
        AND r.workspace_id = NEW.workspace_id
        AND r.guide_id = json_extract(NEW.capture_scope, '$.guideId')
        AND r.status = 'draft'
        AND g.archived_at IS NULL
        AND g.working_draft_revision_id = r.id
    )
    THEN RAISE(ABORT, 'live capture draft required')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS guide_media_require_live_capture_draft
BEFORE INSERT ON guide_media
WHEN NEW.capture_session_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM capture_sessions c
      JOIN guide_revisions r
        ON r.id = NEW.revision_id AND r.workspace_id = c.workspace_id
      JOIN guides g
        ON g.id = r.guide_id AND g.workspace_id = r.workspace_id
      WHERE c.id = NEW.capture_session_id
        AND c.workspace_id = NEW.workspace_id
        AND json_extract(c.capture_scope, '$.revisionId') = r.id
        AND json_extract(c.capture_scope, '$.guideId') = g.id
        AND r.status = 'draft'
        AND g.archived_at IS NULL
        AND g.working_draft_revision_id = r.id
    )
    THEN RAISE(ABORT, 'live capture draft required')
  END;
END;

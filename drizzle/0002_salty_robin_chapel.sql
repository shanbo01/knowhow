PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- These triggers reference guide_media in their body (not just as their own
-- table), so SQLite's schema validation rejects the table rebuild below
-- while they still exist. They are recreated with `CREATE TRIGGER IF NOT
-- EXISTS` on every Worker start (see db/schema.ts trigger statements /
-- ensureSecurityGuards), so dropping them here is safe.
DROP TRIGGER IF EXISTS `capture_sessions_validate_status_transition`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `capture_sessions_validate_scope_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `guide_media_validate_capture_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `guide_media_require_live_capture_draft`;--> statement-breakpoint
CREATE TABLE `__new_guide_media` (
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
	`redaction_state` text DEFAULT 'pending' NOT NULL,
	`source_rasterized` integer DEFAULT false NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`) REFERENCES `guide_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `guide_steps`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`capture_session_id`) REFERENCES `capture_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`revision_id`,`workspace_id`) REFERENCES `guide_revisions`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`,`revision_id`) REFERENCES `guide_steps`(`id`,`revision_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`capture_session_id`,`workspace_id`) REFERENCES `capture_sessions`(`id`,`workspace_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "guide_media_content_type_check" CHECK("__new_guide_media"."content_type" IN ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "guide_media_redaction_check" CHECK("__new_guide_media"."redaction_state" IN ('pending', 'redacted') AND ("__new_guide_media"."redaction_state" != 'redacted' OR "__new_guide_media"."source_rasterized" = 1)),
	CONSTRAINT "guide_media_dimensions_check" CHECK("__new_guide_media"."byte_size" > 0 AND "__new_guide_media"."width" > 0 AND "__new_guide_media"."height" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_guide_media`("id", "workspace_id", "revision_id", "step_id", "capture_session_id", "object_key", "content_type", "byte_size", "width", "height", "sha256", "redaction_state", "source_rasterized", "uploaded_by", "created_at") SELECT "id", "workspace_id", "revision_id", "step_id", "capture_session_id", "object_key", "content_type", "byte_size", "width", "height", "sha256", "redaction_state", "source_rasterized", "uploaded_by", "created_at" FROM `guide_media`;--> statement-breakpoint
DROP TABLE `guide_media`;--> statement-breakpoint
ALTER TABLE `__new_guide_media` RENAME TO `guide_media`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_guide_media_object_key` ON `guide_media` (`object_key`);--> statement-breakpoint
CREATE INDEX `idx_guide_media_revision_step` ON `guide_media` (`revision_id`,`step_id`);--> statement-breakpoint
CREATE INDEX `idx_guide_media_workspace_created` ON `guide_media` (`workspace_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `guides` ADD `screenshots_locked_at` text;
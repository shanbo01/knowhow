PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workspace_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`logo_object_key` text,
	`accent_color` text DEFAULT '#b45309' NOT NULL,
	`click_target_color` text DEFAULT '#d97706' NOT NULL,
	`remove_branding` integer DEFAULT false NOT NULL,
	`restricted_exports_enabled` integer DEFAULT false NOT NULL,
	`watermark_restricted_exports` integer DEFAULT true NOT NULL,
	`capture_policy_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_workspace_settings`("workspace_id", "logo_object_key", "accent_color", "click_target_color", "remove_branding", "restricted_exports_enabled", "watermark_restricted_exports", "capture_policy_json", "created_at", "updated_at") SELECT "workspace_id", "logo_object_key", "accent_color", "click_target_color", "remove_branding", "restricted_exports_enabled", "watermark_restricted_exports", "capture_policy_json", "created_at", "updated_at" FROM `workspace_settings`;--> statement-breakpoint
DROP TABLE `workspace_settings`;--> statement-breakpoint
ALTER TABLE `__new_workspace_settings` RENAME TO `workspace_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

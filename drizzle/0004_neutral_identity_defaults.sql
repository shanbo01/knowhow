-- Upgrade the earlier temporary identity colors to the restrained burnt-orange
-- product accent. Explicit customer-selected branding colors are preserved.
UPDATE `workspace_settings`
SET `accent_color` = '#b45309'
WHERE `accent_color` IN ('#c2410c', '#fb923c', '#3f3f46');
--> statement-breakpoint
UPDATE `workspace_settings`
SET `click_target_color` = '#d97706'
WHERE `click_target_color` IN ('#ea580c', '#f97316', '#52525b');

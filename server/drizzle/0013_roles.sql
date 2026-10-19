ALTER TABLE `users` MODIFY COLUMN `role` enum('admin','consultant','employee','auditor','customer') NOT NULL DEFAULT 'employee';--> statement-breakpoint
ALTER TABLE `projects` ADD `lead_user_id` char(36);--> statement-breakpoint
ALTER TABLE `teams` ADD `lead_user_id` char(36);--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_lead_user_id_users_id_fk` FOREIGN KEY (`lead_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
CREATE TABLE `week_submissions` (
	`organization_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`week` char(8) NOT NULL,
	`hours` decimal(6,2) NOT NULL,
	`submitted_at` datetime NOT NULL,
	CONSTRAINT `week_submissions_user_id_week_pk` PRIMARY KEY(`user_id`,`week`)
);
--> statement-breakpoint
ALTER TABLE `week_submissions` ADD CONSTRAINT `week_submissions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `week_submissions` ADD CONSTRAINT `week_submissions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ws_org_week_idx` ON `week_submissions` (`organization_id`,`week`);
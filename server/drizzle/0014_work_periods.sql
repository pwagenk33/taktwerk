CREATE TABLE `work_periods` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`date` varchar(10) NOT NULL,
	`kind` enum('work','break') NOT NULL DEFAULT 'work',
	`start` varchar(5) NOT NULL,
	`end` varchar(5),
	`created_at` datetime NOT NULL,
	CONSTRAINT `work_periods_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `work_periods` ADD CONSTRAINT `work_periods_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `work_periods` ADD CONSTRAINT `work_periods_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `period_user_date_idx` ON `work_periods` (`user_id`,`date`);--> statement-breakpoint
CREATE INDEX `period_org_date_idx` ON `work_periods` (`organization_id`,`date`);
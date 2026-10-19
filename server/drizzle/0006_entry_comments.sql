CREATE TABLE `entry_comments` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`entry_id` char(36) NOT NULL,
	`author_id` char(36),
	`kind` enum('comment','question') NOT NULL DEFAULT 'comment',
	`text` varchar(1000) NOT NULL,
	`resolved_at` datetime,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `entry_comments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `entry_comments` ADD CONSTRAINT `entry_comments_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `entry_comments` ADD CONSTRAINT `entry_comments_entry_id_time_entries_id_fk` FOREIGN KEY (`entry_id`) REFERENCES `time_entries`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `entry_comments` ADD CONSTRAINT `entry_comments_author_id_users_id_fk` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ec_entry_idx` ON `entry_comments` (`entry_id`);--> statement-breakpoint
CREATE INDEX `ec_org_open_idx` ON `entry_comments` (`organization_id`,`kind`,`resolved_at`);
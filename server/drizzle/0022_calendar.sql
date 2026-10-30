CREATE TABLE `calendar_connections` (
	`user_id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`provider` enum('microsoft','google') NOT NULL,
	`account` varchar(255),
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_at` datetime NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `calendar_connections_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
ALTER TABLE `calendar_connections` ADD CONSTRAINT `calendar_connections_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calendar_connections` ADD CONSTRAINT `calendar_connections_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;
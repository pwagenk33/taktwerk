CREATE TABLE `git_connections` (
	`user_id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`provider` enum('github','gitlab') NOT NULL,
	`base_url` varchar(255) NOT NULL,
	`account` varchar(120) NOT NULL,
	`token` text NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `git_connections_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
ALTER TABLE `git_connections` ADD CONSTRAINT `git_connections_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `git_connections` ADD CONSTRAINT `git_connections_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;
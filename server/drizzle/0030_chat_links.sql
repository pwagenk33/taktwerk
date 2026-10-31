CREATE TABLE `chat_links` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`provider` enum('slack','teams') NOT NULL,
	`external_id` varchar(120) NOT NULL,
	`user_id` char(36) NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `chat_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `chat_links_uq` UNIQUE(`organization_id`,`provider`,`external_id`)
);
--> statement-breakpoint
ALTER TABLE `chat_links` ADD CONSTRAINT `chat_links_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_links` ADD CONSTRAINT `chat_links_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
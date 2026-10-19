CREATE TABLE `passkeys` (
	`id` varchar(512) NOT NULL,
	`user_id` char(36) NOT NULL,
	`public_key` varchar(1024) NOT NULL,
	`counter` int NOT NULL DEFAULT 0,
	`transports` json,
	`name` varchar(80) NOT NULL,
	`backed_up` boolean NOT NULL DEFAULT false,
	`last_used_at` datetime,
	`created_at` datetime NOT NULL,
	CONSTRAINT `passkeys_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `password_tokens` MODIFY COLUMN `purpose` enum('invite','reset','2fa') NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `user_agent` varchar(255);--> statement-breakpoint
ALTER TABLE `sessions` ADD `ip` varchar(45);--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_seen_at` datetime;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_secret` varchar(64);--> statement-breakpoint
ALTER TABLE `users` ADD `totp_enabled_at` datetime;--> statement-breakpoint
ALTER TABLE `users` ADD `recovery_codes` json;--> statement-breakpoint
ALTER TABLE `passkeys` ADD CONSTRAINT `passkeys_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`user_id`);
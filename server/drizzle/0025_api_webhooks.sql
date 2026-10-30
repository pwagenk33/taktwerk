CREATE TABLE `api_keys` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`name` varchar(80) NOT NULL,
	`prefix` varchar(16) NOT NULL,
	`hash` char(64) NOT NULL,
	`scope` enum('read','write') NOT NULL,
	`user_id` char(36) NOT NULL,
	`last_used_at` datetime,
	`revoked_at` datetime,
	`created_at` datetime NOT NULL,
	CONSTRAINT `api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_key_hash_uq` UNIQUE(`hash`)
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`endpoint_id` char(36) NOT NULL,
	`event` varchar(60) NOT NULL,
	`payload` json NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`next_attempt_at` datetime NOT NULL,
	`delivered_at` datetime,
	`failed_at` datetime,
	`last_status` int,
	`last_error` varchar(500),
	`created_at` datetime NOT NULL,
	CONSTRAINT `webhook_deliveries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`url` varchar(500) NOT NULL,
	`description` varchar(120),
	`events` json NOT NULL,
	`secret` varchar(80) NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`failures` int NOT NULL DEFAULT 0,
	`last_status` int,
	`last_delivery_at` datetime,
	`created_at` datetime NOT NULL,
	CONSTRAINT `webhook_endpoints_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `api_keys` ADD CONSTRAINT `api_keys_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `api_keys` ADD CONSTRAINT `api_keys_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `webhook_deliveries` ADD CONSTRAINT `webhook_deliveries_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `webhook_deliveries` ADD CONSTRAINT `webhook_deliveries_endpoint_id_webhook_endpoints_id_fk` FOREIGN KEY (`endpoint_id`) REFERENCES `webhook_endpoints`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `webhook_endpoints` ADD CONSTRAINT `webhook_endpoints_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `api_key_org_idx` ON `api_keys` (`organization_id`);--> statement-breakpoint
CREATE INDEX `whd_due_idx` ON `webhook_deliveries` (`delivered_at`,`failed_at`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `whd_endpoint_idx` ON `webhook_deliveries` (`endpoint_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `wh_org_idx` ON `webhook_endpoints` (`organization_id`);
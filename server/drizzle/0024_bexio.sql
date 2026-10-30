CREATE TABLE `bexio_connections` (
	`organization_id` char(36) NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_at` datetime NOT NULL,
	`bexio_user_id` int NOT NULL,
	`account` varchar(255),
	`contacts` json NOT NULL,
	`connected_by` char(36),
	`created_at` datetime NOT NULL,
	CONSTRAINT `bexio_connections_organization_id` PRIMARY KEY(`organization_id`)
);
--> statement-breakpoint
ALTER TABLE `invoices` ADD `bexio_id` varchar(20);--> statement-breakpoint
ALTER TABLE `bexio_connections` ADD CONSTRAINT `bexio_connections_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bexio_connections` ADD CONSTRAINT `bexio_connections_connected_by_users_id_fk` FOREIGN KEY (`connected_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
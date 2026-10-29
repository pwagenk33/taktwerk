CREATE TABLE `jira_connections` (
	`organization_id` char(36) NOT NULL,
	`cloud_id` varchar(64) NOT NULL,
	`site_url` varchar(255) NOT NULL,
	`site_name` varchar(255) NOT NULL,
	`access_token` varchar(4096) NOT NULL,
	`refresh_token` varchar(4096),
	`expires_at` datetime NOT NULL,
	`story_point_fields` json NOT NULL,
	`connected_by` char(36),
	`last_sync_at` datetime,
	`last_result` json,
	`created_at` datetime NOT NULL,
	CONSTRAINT `jira_connections_organization_id` PRIMARY KEY(`organization_id`)
);
--> statement-breakpoint
ALTER TABLE `jira_connections` ADD CONSTRAINT `jira_connections_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jira_connections` ADD CONSTRAINT `jira_connections_connected_by_users_id_fk` FOREIGN KEY (`connected_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
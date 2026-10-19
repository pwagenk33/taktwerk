CREATE TABLE `allocations` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`project_id` char(36) NOT NULL,
	`week` char(8) NOT NULL,
	`hours` decimal(5,1) NOT NULL,
	`note` varchar(200),
	`updated_at` datetime NOT NULL,
	CONSTRAINT `allocations_id` PRIMARY KEY(`id`),
	CONSTRAINT `alloc_uq` UNIQUE(`user_id`,`project_id`,`week`)
);
--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `role` enum('admin','consultant','employee','customer') NOT NULL DEFAULT 'employee';--> statement-breakpoint
ALTER TABLE `users` ADD `customer_id` char(36);--> statement-breakpoint
ALTER TABLE `allocations` ADD CONSTRAINT `allocations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `allocations` ADD CONSTRAINT `allocations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `allocations` ADD CONSTRAINT `allocations_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `alloc_org_week_idx` ON `allocations` (`organization_id`,`week`);--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;
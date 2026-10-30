CREATE TABLE `import_batches` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`source` varchar(20) NOT NULL,
	`file_name` varchar(255) NOT NULL,
	`entries` int NOT NULL,
	`hours` decimal(10,2) NOT NULL,
	`created` json NOT NULL,
	`created_by` char(36),
	`undone_at` datetime,
	`created_at` datetime NOT NULL,
	CONSTRAINT `import_batches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `audit_log` MODIFY COLUMN `entity` enum('time_entry','expense','month','absence','work_model','import') NOT NULL;--> statement-breakpoint
ALTER TABLE `time_entries` ADD `import_batch_id` char(36);--> statement-breakpoint
ALTER TABLE `import_batches` ADD CONSTRAINT `import_batches_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `import_batches` ADD CONSTRAINT `import_batches_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `te_import_idx` ON `time_entries` (`import_batch_id`);
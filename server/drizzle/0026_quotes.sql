CREATE TABLE `quotes` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`customer_id` char(36) NOT NULL,
	`number` varchar(20) NOT NULL,
	`title` varchar(200) NOT NULL,
	`intro` text,
	`kind` enum('tm','fixed','retainer') NOT NULL DEFAULT 'tm',
	`retainer_hours` decimal(6,1),
	`valid_until` date NOT NULL,
	`status` enum('draft','sent','accepted','declined') NOT NULL DEFAULT 'draft',
	`positions` json NOT NULL,
	`net` decimal(12,2) NOT NULL,
	`project_id` char(36),
	`decided_at` datetime,
	`created_at` datetime NOT NULL,
	CONSTRAINT `quotes_id` PRIMARY KEY(`id`),
	CONSTRAINT `quote_number_uq` UNIQUE(`organization_id`,`number`)
);
--> statement-breakpoint
ALTER TABLE `quotes` ADD CONSTRAINT `quotes_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `quotes` ADD CONSTRAINT `quotes_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `quote_customer_idx` ON `quotes` (`customer_id`);
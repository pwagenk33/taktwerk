CREATE TABLE `invoices` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`customer_id` char(36) NOT NULL,
	`number` varchar(20) NOT NULL,
	`month` char(7) NOT NULL,
	`issue_date` date NOT NULL,
	`due_date` date NOT NULL,
	`status` enum('draft','sent','paid','cancelled') NOT NULL DEFAULT 'draft',
	`positions` json NOT NULL,
	`net` decimal(12,2) NOT NULL,
	`vat_rate` decimal(4,1) NOT NULL,
	`vat` decimal(12,2) NOT NULL,
	`gross` decimal(12,2) NOT NULL,
	`snapshot` json NOT NULL,
	`sent_at` datetime,
	`paid_at` datetime,
	`created_at` datetime NOT NULL,
	CONSTRAINT `invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `inv_number_uq` UNIQUE(`organization_id`,`number`)
);
--> statement-breakpoint
ALTER TABLE `expenses` MODIFY COLUMN `category` enum('Reise','Kilometer','Unterkunft','Verpflegung','Material','Lizenzen','Sonstiges') NOT NULL;--> statement-breakpoint
ALTER TABLE `customers` ADD `billing_address` json;--> statement-breakpoint
ALTER TABLE `expenses` ADD `status` enum('requested','approved','rejected') DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE `expenses` ADD `decided_by` char(36);--> statement-breakpoint
ALTER TABLE `expenses` ADD `decided_at` datetime;--> statement-breakpoint
ALTER TABLE `expenses` ADD `vat_rate` decimal(4,1) DEFAULT 8.1 NOT NULL;--> statement-breakpoint
ALTER TABLE `expenses` ADD `km` decimal(7,1);--> statement-breakpoint
ALTER TABLE `expenses` ADD `receipt_name` varchar(255);--> statement-breakpoint
ALTER TABLE `expenses` ADD `receipt_mime` varchar(100);--> statement-breakpoint
ALTER TABLE `expenses` ADD `receipt_size` int;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `inv_customer_idx` ON `invoices` (`customer_id`);--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_decided_by_users_id_fk` FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ex_status_idx` ON `expenses` (`organization_id`,`status`);
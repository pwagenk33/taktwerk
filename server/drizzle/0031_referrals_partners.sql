CREATE TABLE `partners` (
	`id` char(36) NOT NULL,
	`code` varchar(40) NOT NULL,
	`name` varchar(200) NOT NULL,
	`email` varchar(254) NOT NULL,
	`commission_percent` int NOT NULL DEFAULT 20,
	`trial_days` int NOT NULL DEFAULT 60,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` datetime NOT NULL,
	CONSTRAINT `partners_id` PRIMARY KEY(`id`),
	CONSTRAINT `partners_code_uq` UNIQUE(`code`)
);
--> statement-breakpoint
ALTER TABLE `organizations` ADD `referral_code` varchar(20);--> statement-breakpoint
ALTER TABLE `organizations` ADD `referred_by_org_id` varchar(36);--> statement-breakpoint
ALTER TABLE `organizations` ADD `partner_id` varchar(36);--> statement-breakpoint
ALTER TABLE `organizations` ADD `free_months_used` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD CONSTRAINT `org_referral_uq` UNIQUE(`referral_code`);--> statement-breakpoint
CREATE INDEX `org_referred_idx` ON `organizations` (`referred_by_org_id`);--> statement-breakpoint
CREATE INDEX `org_partner_idx` ON `organizations` (`partner_id`);
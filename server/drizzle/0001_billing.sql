CREATE TABLE `audit_log` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`actor_id` char(36),
	`entity` enum('time_entry','expense','month') NOT NULL,
	`entity_id` varchar(64) NOT NULL,
	`action` enum('create','update','delete','submit','approve','reopen') NOT NULL,
	`before_data` json,
	`after_data` json,
	`created_at` datetime NOT NULL,
	CONSTRAINT `audit_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `budget_alerts` (
	`organization_id` char(36) NOT NULL,
	`target_id` char(36) NOT NULL,
	`threshold` enum('80','95','100') NOT NULL,
	`sent_at` datetime NOT NULL,
	CONSTRAINT `budget_alerts_target_id_threshold_pk` PRIMARY KEY(`target_id`,`threshold`)
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`job` varchar(120) NOT NULL,
	`period` varchar(20) NOT NULL,
	`ran_at` datetime NOT NULL,
	CONSTRAINT `job_runs_job_period_pk` PRIMARY KEY(`job`,`period`)
);
--> statement-breakpoint
CREATE TABLE `month_closings` (
	`organization_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`month` char(7) NOT NULL,
	`status` enum('submitted','approved') NOT NULL,
	`submitted_at` datetime NOT NULL,
	`approved_by` char(36),
	`approved_at` datetime,
	CONSTRAINT `month_closings_user_id_month_pk` PRIMARY KEY(`user_id`,`month`)
);
--> statement-breakpoint
ALTER TABLE `customers` ADD `report_recipients` json NOT NULL DEFAULT ('[]');--> statement-breakpoint
ALTER TABLE `audit_log` ADD CONSTRAINT `audit_log_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audit_log` ADD CONSTRAINT `audit_log_actor_id_users_id_fk` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `budget_alerts` ADD CONSTRAINT `budget_alerts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `month_closings` ADD CONSTRAINT `month_closings_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `month_closings` ADD CONSTRAINT `month_closings_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `month_closings` ADD CONSTRAINT `month_closings_approved_by_users_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_org_idx` ON `audit_log` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `mc_org_month_idx` ON `month_closings` (`organization_id`,`month`);
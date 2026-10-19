CREATE TABLE `absences` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`type` enum('Ferien','Krankheit','Unfall','Militär/Zivildienst','Weiterbildung','Kompensation','Sonstiges') NOT NULL,
	`start_date` date NOT NULL,
	`end_date` date NOT NULL,
	`half_day` boolean NOT NULL DEFAULT false,
	`note` varchar(500),
	`status` enum('requested','approved','rejected') NOT NULL,
	`decided_by` char(36),
	`decided_at` datetime,
	`created_at` datetime NOT NULL,
	CONSTRAINT `absences_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `audit_log` MODIFY COLUMN `entity` enum('time_entry','expense','month','absence','work_model') NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_log` MODIFY COLUMN `action` enum('create','update','delete','submit','approve','reopen','reject') NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `workload` int DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `vacation_days` decimal(4,1) DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `tracking_start` date;--> statement-breakpoint
ALTER TABLE `users` ADD `overtime_carry` decimal(7,2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `vacation_carry` decimal(4,1) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `absences` ADD CONSTRAINT `absences_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `absences` ADD CONSTRAINT `absences_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `absences` ADD CONSTRAINT `absences_decided_by_users_id_fk` FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `abs_org_start_idx` ON `absences` (`organization_id`,`start_date`);--> statement-breakpoint
CREATE INDEX `abs_user_idx` ON `absences` (`user_id`);
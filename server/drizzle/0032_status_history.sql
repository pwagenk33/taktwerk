CREATE TABLE `incidents` (
	`id` char(36) NOT NULL,
	`title` varchar(200) NOT NULL,
	`impact` enum('minor','major','maintenance') NOT NULL,
	`status` enum('investigating','identified','monitoring','resolved','scheduled','in_progress','completed') NOT NULL,
	`starts_at` datetime NOT NULL,
	`ends_at` datetime,
	`updates` json NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `incidents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `status_days` (
	`day` date NOT NULL,
	`ok_minutes` int NOT NULL DEFAULT 0,
	`bad_minutes` int NOT NULL DEFAULT 0,
	`first_at` datetime NOT NULL,
	`last_at` datetime NOT NULL,
	CONSTRAINT `status_days_day` PRIMARY KEY(`day`)
);
--> statement-breakpoint
CREATE INDEX `incidents_start_idx` ON `incidents` (`starts_at`);
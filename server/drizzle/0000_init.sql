CREATE TABLE `customer_rates` (
	`customer_id` char(36) NOT NULL,
	`valid_from` date NOT NULL,
	`hourly_rate` decimal(12,2) NOT NULL,
	CONSTRAINT `customer_rates_customer_id_valid_from_pk` PRIMARY KEY(`customer_id`,`valid_from`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `customers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `dashboards` (
	`user_id` char(36) NOT NULL,
	`layout` json NOT NULL,
	CONSTRAINT `dashboards_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`sub_project_id` char(36) NOT NULL,
	`date` date NOT NULL,
	`amount` decimal(12,2) NOT NULL,
	`category` enum('Reise','Unterkunft','Verpflegung','Material','Lizenzen','Sonstiges') NOT NULL,
	`reason` varchar(1000) NOT NULL,
	`billable` boolean NOT NULL DEFAULT true,
	`created_at` datetime NOT NULL,
	CONSTRAINT `expenses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `jira_issues` (
	`organization_id` char(36) NOT NULL,
	`issue_key` varchar(40) NOT NULL,
	`sub_project_id` char(36) NOT NULL,
	`summary` varchar(500) NOT NULL,
	`story_points` decimal(6,1) NOT NULL DEFAULT 0,
	`status` enum('To Do','In Progress','Done') NOT NULL,
	`resolved_at` date,
	CONSTRAINT `jira_issues_organization_id_issue_key_pk` PRIMARY KEY(`organization_id`,`issue_key`)
);
--> statement-breakpoint
CREATE TABLE `oauth_accounts` (
	`provider` enum('microsoft','google') NOT NULL,
	`provider_user_id` varchar(191) NOT NULL,
	`user_id` char(36) NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `oauth_accounts_provider_provider_user_id_pk` PRIMARY KEY(`provider`,`provider_user_id`)
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` char(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`settings` json NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `organizations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `password_tokens` (
	`id` char(64) NOT NULL,
	`user_id` char(36) NOT NULL,
	`purpose` enum('invite','reset') NOT NULL,
	`expires_at` datetime NOT NULL,
	`used_at` datetime,
	`created_at` datetime NOT NULL,
	CONSTRAINT `password_tokens_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`customer_id` char(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`budget` decimal(12,2) NOT NULL DEFAULT 0,
	`jira_project_key` varchar(20),
	`created_at` datetime NOT NULL,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` char(64) NOT NULL,
	`user_id` char(36) NOT NULL,
	`expires_at` datetime NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sub_projects` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`project_id` char(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`budget` decimal(12,2) NOT NULL DEFAULT 0,
	`jira_epic_key` varchar(40),
	`created_at` datetime NOT NULL,
	CONSTRAINT `sub_projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`name` varchar(120) NOT NULL,
	CONSTRAINT `teams_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `time_entries` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`sub_project_id` char(36) NOT NULL,
	`date` date NOT NULL,
	`hours` decimal(5,2) NOT NULL,
	`reason` varchar(1000) NOT NULL,
	`billable` boolean NOT NULL DEFAULT true,
	`hourly_rate` decimal(12,2) NOT NULL,
	`jira_issue_key` varchar(40),
	`created_at` datetime NOT NULL,
	CONSTRAINT `time_entries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`team_id` char(36),
	`username` varchar(80) NOT NULL,
	`email` varchar(254) NOT NULL,
	`name` varchar(160) NOT NULL,
	`role` enum('admin','consultant','employee') NOT NULL DEFAULT 'employee',
	`password_hash` varchar(255),
	`active` boolean NOT NULL DEFAULT true,
	`last_login_at` datetime,
	`created_at` datetime NOT NULL,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_username_uq` UNIQUE(`username`),
	CONSTRAINT `users_email_uq` UNIQUE(`email`)
);
--> statement-breakpoint
ALTER TABLE `customer_rates` ADD CONSTRAINT `customer_rates_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customers` ADD CONSTRAINT `customers_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dashboards` ADD CONSTRAINT `dashboards_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_sub_project_id_sub_projects_id_fk` FOREIGN KEY (`sub_project_id`) REFERENCES `sub_projects`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jira_issues` ADD CONSTRAINT `jira_issues_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jira_issues` ADD CONSTRAINT `jira_issues_sub_project_id_sub_projects_id_fk` FOREIGN KEY (`sub_project_id`) REFERENCES `sub_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_accounts` ADD CONSTRAINT `oauth_accounts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `password_tokens` ADD CONSTRAINT `password_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sub_projects` ADD CONSTRAINT `sub_projects_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sub_projects` ADD CONSTRAINT `sub_projects_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teams` ADD CONSTRAINT `teams_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `time_entries` ADD CONSTRAINT `time_entries_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `time_entries` ADD CONSTRAINT `time_entries_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `time_entries` ADD CONSTRAINT `time_entries_sub_project_id_sub_projects_id_fk` FOREIGN KEY (`sub_project_id`) REFERENCES `sub_projects`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ex_org_date_idx` ON `expenses` (`organization_id`,`date`);--> statement-breakpoint
CREATE INDEX `ji_sub_idx` ON `jira_issues` (`sub_project_id`);--> statement-breakpoint
CREATE INDEX `oauth_user_idx` ON `oauth_accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `te_org_date_idx` ON `time_entries` (`organization_id`,`date`);--> statement-breakpoint
CREATE INDEX `te_sub_idx` ON `time_entries` (`sub_project_id`);--> statement-breakpoint
CREATE INDEX `te_issue_idx` ON `time_entries` (`jira_issue_key`);
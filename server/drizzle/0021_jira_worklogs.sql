CREATE TABLE `jira_worklogs` (
	`time_entry_id` char(36) NOT NULL,
	`organization_id` char(36) NOT NULL,
	`issue_key` varchar(40) NOT NULL,
	`worklog_id` varchar(40) NOT NULL,
	`hash` char(40) NOT NULL,
	`synced_at` datetime NOT NULL,
	CONSTRAINT `jira_worklogs_time_entry_id` PRIMARY KEY(`time_entry_id`)
);
--> statement-breakpoint
ALTER TABLE `jira_connections` ADD `scopes` json;--> statement-breakpoint
ALTER TABLE `jira_connections` ADD `worklogs_since` date;--> statement-breakpoint
ALTER TABLE `jira_connections` ADD `last_worklog_result` json;--> statement-breakpoint
ALTER TABLE `jira_worklogs` ADD CONSTRAINT `jira_worklogs_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `jw_org_idx` ON `jira_worklogs` (`organization_id`);
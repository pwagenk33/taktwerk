CREATE INDEX `ex_user_date_idx` ON `expenses` (`user_id`,`date`);--> statement-breakpoint
CREATE INDEX `te_user_date_idx` ON `time_entries` (`user_id`,`date`);
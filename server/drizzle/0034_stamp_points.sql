ALTER TABLE `work_periods` ADD `source` enum('app','nfc','location','manual');--> statement-breakpoint
ALTER TABLE `work_periods` ADD `point_id` varchar(36);
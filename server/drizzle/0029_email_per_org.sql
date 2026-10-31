ALTER TABLE `users` DROP INDEX `users_email_uq`;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_org_email_uq` UNIQUE(`organization_id`,`email`);--> statement-breakpoint
CREATE INDEX `users_email_idx` ON `users` (`email`);
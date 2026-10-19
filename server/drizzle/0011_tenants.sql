ALTER TABLE `organizations` ADD `slug` varchar(60);--> statement-breakpoint
ALTER TABLE `organizations` ADD `domain` varchar(200);--> statement-breakpoint
ALTER TABLE `organizations` ADD `active` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `platform_admin` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD CONSTRAINT `org_slug_uq` UNIQUE(`slug`);--> statement-breakpoint
ALTER TABLE `organizations` ADD CONSTRAINT `org_domain_uq` UNIQUE(`domain`);
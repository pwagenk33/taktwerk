ALTER TABLE `customers` ADD `locale` varchar(2) DEFAULT 'de' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `locale` varchar(2);
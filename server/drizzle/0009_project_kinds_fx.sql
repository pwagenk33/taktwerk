ALTER TABLE `customers` ADD `currency` enum('CHF','EUR','USD') DEFAULT 'CHF' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `kind` enum('tm','fixed','retainer') DEFAULT 'tm' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `retainer_hours` decimal(6,1);--> statement-breakpoint
ALTER TABLE `users` ADD `cost_rate` decimal(7,2);
ALTER TABLE `password_tokens` MODIFY COLUMN `purpose` enum('invite','reset','2fa','handoff') NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `plan` enum('start','team','business') DEFAULT 'business' NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `sub_status` enum('trialing','active','past_due','canceled','expired') DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `billing_interval` enum('month','year') DEFAULT 'month' NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `billing_mode` enum('stripe','invoice') DEFAULT 'invoice' NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `trial_ends_at` datetime;--> statement-breakpoint
ALTER TABLE `organizations` ADD `current_period_end` datetime;--> statement-breakpoint
ALTER TABLE `organizations` ADD `stripe_customer_id` varchar(64);--> statement-breakpoint
ALTER TABLE `organizations` ADD `stripe_subscription_id` varchar(64);--> statement-breakpoint
ALTER TABLE `organizations` ADD `canceled_at` datetime;--> statement-breakpoint
CREATE INDEX `org_stripe_sub_idx` ON `organizations` (`stripe_subscription_id`);
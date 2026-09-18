ALTER TABLE `users` ADD `stripe_connected_account_id` varchar(255);--> statement-breakpoint
ALTER TABLE `users` ADD `payout_onboarding_status` enum('none','requested','done') DEFAULT 'none' NOT NULL;
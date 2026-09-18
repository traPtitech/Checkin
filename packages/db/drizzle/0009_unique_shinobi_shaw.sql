ALTER TABLE `payouts` ADD `payout_method` enum('stripe_connect','manual_bank') DEFAULT 'stripe_connect' NOT NULL;--> statement-breakpoint
ALTER TABLE `payouts` ADD `manual_paid_at` timestamp;--> statement-breakpoint
ALTER TABLE `payouts` ADD `manual_paid_note` varchar(255);--> statement-breakpoint
ALTER TABLE `payouts` ADD `manual_paid_by` varchar(36);--> statement-breakpoint
ALTER TABLE `payouts` ADD CONSTRAINT `payouts_manual_paid_by_users_id_fk` FOREIGN KEY (`manual_paid_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
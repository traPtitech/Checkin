CREATE TABLE `payouts` (
	`id` varchar(36) NOT NULL,
	`jomon_ref` varchar(255) NOT NULL,
	`user_id` varchar(36),
	`amount` int NOT NULL,
	`currency` varchar(8) NOT NULL,
	`status` enum('pending','onboarding_waiting','paid','failed') NOT NULL DEFAULT 'pending',
	`stripe_transfer_id` varchar(255),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payouts_id` PRIMARY KEY(`id`),
	CONSTRAINT `payouts_jomon_ref_unique` UNIQUE(`jomon_ref`)
);
--> statement-breakpoint
ALTER TABLE `payouts` ADD CONSTRAINT `payouts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
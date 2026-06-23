CREATE TABLE `membership_slots` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`activity_year` int NOT NULL,
	`half` enum('zenki','kouki') NOT NULL,
	`charge_group` varchar(36) NOT NULL,
	`stripe_invoice_id` varchar(255),
	`status` enum('open','paid') NOT NULL DEFAULT 'open',
	`paid_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `membership_slots_id` PRIMARY KEY(`id`),
	CONSTRAINT `membership_slots_user_year_half_uq` UNIQUE(`user_id`,`activity_year`,`half`)
);
--> statement-breakpoint
ALTER TABLE `membership_slots` ADD CONSTRAINT `membership_slots_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
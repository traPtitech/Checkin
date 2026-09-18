CREATE TABLE `stripe_events` (
	`id` varchar(36) NOT NULL,
	`event_id` varchar(255) NOT NULL,
	`type` varchar(255) NOT NULL,
	`received_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `stripe_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `stripe_events_event_id_unique` UNIQUE(`event_id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `stripe_customer_id` varchar(255);
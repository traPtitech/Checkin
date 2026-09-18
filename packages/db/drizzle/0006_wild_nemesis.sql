ALTER TABLE `sessions` ADD `is_admin` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `traq_id` varchar(255);--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_traq_id_unique` UNIQUE(`traq_id`);--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `actor_type`;
CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tally_guid` text,
	`name` text NOT NULL,
	`parent_name` text,
	`category` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`opening_balance` real DEFAULT 0 NOT NULL,
	`is_historical` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_tally_guid_unique` ON `accounts` (`tally_guid`);--> statement-breakpoint
CREATE TABLE `entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`voucher_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`amount` real NOT NULL,
	`is_debit` integer NOT NULL,
	FOREIGN KEY (`voucher_id`) REFERENCES `vouchers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `migration_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_label` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`voucher_count` integer DEFAULT 0 NOT NULL,
	`account_count` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`checksum` text
);
--> statement-breakpoint
CREATE TABLE `vouchers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tally_guid` text NOT NULL,
	`voucher_number` text,
	`voucher_type` text NOT NULL,
	`transaction_date` text NOT NULL,
	`narration` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`is_historical` integer DEFAULT true NOT NULL,
	`imported_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vouchers_tally_guid_idx` ON `vouchers` (`tally_guid`);
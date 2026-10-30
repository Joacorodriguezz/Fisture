CREATE TABLE `calendar_syncs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`match_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_event_id` text,
	`status` text DEFAULT 'pending',
	`last_synced_at` integer,
	`synced_date_time` integer,
	`synced_state` text,
	`synced_venue` text,
	`error_message` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_calendar_syncs_status` ON `calendar_syncs` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_calendar_syncs_user_match` ON `calendar_syncs` (`user_id`,`match_id`);--> statement-breakpoint
CREATE TABLE `league_teams` (
	`league_id` text NOT NULL,
	`team_id` text NOT NULL,
	PRIMARY KEY(`league_id`, `team_id`),
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_league_teams_team` ON `league_teams` (`team_id`);--> statement-breakpoint
CREATE TABLE `leagues` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`country` text NOT NULL,
	`logo` text,
	`season` integer NOT NULL,
	`source` text DEFAULT 'football-data' NOT NULL,
	`is_active` integer DEFAULT true
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leagues_external_id_unique` ON `leagues` (`external_id`);--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`home_team_id` text NOT NULL,
	`away_team_id` text NOT NULL,
	`league_id` text NOT NULL,
	`date_time` integer NOT NULL,
	`venue` text,
	`status` text DEFAULT 'scheduled',
	`home_score` integer,
	`away_score` integer,
	`round` text,
	`source` text DEFAULT 'football-data' NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`home_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`away_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `matches_external_id_unique` ON `matches` (`external_id`);--> statement-breakpoint
CREATE INDEX `idx_matches_date` ON `matches` (`date_time`);--> statement-breakpoint
CREATE INDEX `idx_matches_home_team` ON `matches` (`home_team_id`);--> statement-breakpoint
CREATE INDEX `idx_matches_away_team` ON `matches` (`away_team_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`duration_ms` integer,
	`results` text DEFAULT '[]' NOT NULL,
	`issues` text DEFAULT '[]' NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_sync_runs_started` ON `sync_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`short_name` text,
	`logo` text,
	`league_id` text NOT NULL,
	`country` text,
	`source` text DEFAULT 'football-data' NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_external_id_unique` ON `teams` (`external_id`);--> statement-breakpoint
CREATE INDEX `idx_teams_name` ON `teams` (`name`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`reminder_60` integer DEFAULT true NOT NULL,
	`reminder_15` integer DEFAULT true NOT NULL,
	`theme` text DEFAULT 'papel' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`team_id` text NOT NULL,
	`auto_sync` integer DEFAULT true,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_teams_user` ON `user_teams` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_user_teams_team` ON `user_teams` (`team_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`image` text,
	`provider` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`token_expires_at` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
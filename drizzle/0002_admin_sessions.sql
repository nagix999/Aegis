CREATE TABLE IF NOT EXISTS `aegis_auth_meta` (
  `name` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aegis_admin_sessions` (
  `token_hash` text PRIMARY KEY NOT NULL,
  `identity` text NOT NULL,
  `credential_fingerprint` text NOT NULL,
  `created_at` real NOT NULL,
  `last_seen` real NOT NULL,
  `expires_at` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `aegis_admin_sessions_expiry` ON `aegis_admin_sessions` (`expires_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aegis_auth_attempts` (
  `scope` text PRIMARY KEY NOT NULL,
  `window_start` real NOT NULL,
  `attempts` integer NOT NULL
);

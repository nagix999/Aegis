CREATE TABLE `aegis_deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`alias` text NOT NULL,
	`version` integer NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aegis_deployment_alias_version` ON `aegis_deployments` (`alias`,`version`);--> statement-breakpoint
CREATE TABLE `aegis_gateway_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aegis_gateway_keys_hash_unique` ON `aegis_gateway_keys` (`hash`);--> statement-breakpoint
CREATE TABLE `aegis_records` (
	`namespace` text NOT NULL,
	`id` text NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`namespace`, `id`)
);
--> statement-breakpoint
CREATE TABLE `aegis_request_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);

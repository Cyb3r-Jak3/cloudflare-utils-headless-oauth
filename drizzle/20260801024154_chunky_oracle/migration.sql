CREATE TABLE `tokens` (
	`registrationId` text,
	`accessToken` text,
	`expiresAt` integer,
	`retrieveToken` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_registrationId` ON `tokens` (`registrationId`);
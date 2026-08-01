ALTER TABLE `tokens` RENAME TO `registrations`;--> statement-breakpoint
ALTER TABLE `registrations` ADD `codeVerifier` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_registrations` (
	`registrationId` text NOT NULL,
	`codeVerifier` text,
	`accessToken` text,
	`expiresAt` integer NOT NULL,
	`retrieveToken` text
);
--> statement-breakpoint
INSERT INTO `__new_registrations`(`registrationId`, `accessToken`, `expiresAt`, `retrieveToken`) SELECT `registrationId`, `accessToken`, `expiresAt`, `retrieveToken` FROM `registrations`;--> statement-breakpoint
DROP TABLE `registrations`;--> statement-breakpoint
ALTER TABLE `__new_registrations` RENAME TO `registrations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_registrationId` ON `registrations` (`registrationId`);
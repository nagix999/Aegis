ALTER TABLE `aegis_records` ADD COLUMN `revision` text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE `aegis_records` SET `revision` = lower(hex(randomblob(16)));
--> statement-breakpoint
CREATE TRIGGER `aegis_records_revision_insert` AFTER INSERT ON `aegis_records`
BEGIN
  UPDATE `aegis_records` SET `revision` = lower(hex(randomblob(16))) WHERE `namespace` = NEW.`namespace` AND `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `aegis_records_revision_update` AFTER UPDATE OF `payload` ON `aegis_records`
BEGIN
  UPDATE `aegis_records` SET `revision` = lower(hex(randomblob(16))) WHERE `namespace` = NEW.`namespace` AND `id` = NEW.`id`;
END;

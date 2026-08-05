-- Datetime injection becomes a per-instance flag; the editable 08-datetime
-- prompt section is removed. Backfill the flag from existing section content
-- (preserve per-instance behaviour: an instance that had blanked the section
-- stays OFF), THEN delete the now-dead rows. Order matters: the flag must be
-- computed from the rows before they are deleted.
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "datetime_injection_enabled" boolean NOT NULL DEFAULT true;
UPDATE "instances" i SET "datetime_injection_enabled" = EXISTS (
  SELECT 1 FROM "instance_prompts" p
  WHERE p.instance_id = i.id
    AND p.section_key = '08-datetime'
    AND btrim(p.content) <> ''
);
DELETE FROM "instance_prompts" WHERE section_key = '08-datetime';

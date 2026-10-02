-- Copying the files end users send into the agent's bucket becomes an explicit
-- per-agent choice. Until now an agent whose fileUpload secrets name a bucket
-- stored every inbound attachment there, with no switch and no deletion. Every
-- agent, existing or new, starts with the copy off.
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "attachment_storage_enabled" boolean DEFAULT false NOT NULL;

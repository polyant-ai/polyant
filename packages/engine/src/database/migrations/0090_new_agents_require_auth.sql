-- A newly created agent now requires its API key (auth_enabled defaults to true).
-- Only the column DEFAULT changes: existing rows keep the value they have, and
-- imports keep what the bundle says because they always write the column.
ALTER TABLE "instances" ALTER COLUMN "auth_enabled" SET DEFAULT true;

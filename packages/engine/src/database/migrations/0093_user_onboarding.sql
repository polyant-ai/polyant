-- Per-user first-access guidance state (wizard, interface tour, agent tour).
-- NULL reads as "never recorded", which the panel treats as "show it".
ALTER TABLE "users" ADD COLUMN "onboarding" jsonb;

-- Accounts that exist when this migration runs belong to people who already use
-- the panel: they would otherwise get a full-screen setup wizard on their next
-- visit. They start dismissed, and the Help menu still reopens everything. Users
-- created afterwards keep NULL and see the guidance.
UPDATE "users"
SET "onboarding" = '{"wizard":"dismissed","interfaceTour":"dismissed","agentTour":"dismissed","steps":{}}'::jsonb
WHERE "onboarding" IS NULL;

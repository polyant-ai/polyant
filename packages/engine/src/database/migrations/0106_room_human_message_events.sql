-- A message from a Room's contact is queued as a backlog event with no definition,
-- so one that arrives while a cycle runs waits for the next cycle instead of being
-- dropped.
ALTER TABLE "event_backlog" ALTER COLUMN "event_definition_id" DROP NOT NULL;

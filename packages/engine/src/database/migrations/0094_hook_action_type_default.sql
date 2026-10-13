-- 0061 removed tool hooks and moved the default to 'function' in the Drizzle
-- schema only, so the database kept DEFAULT 'tool' from 0046: an insert that
-- omits action_type still wrote a hook type the engine no longer runs.
ALTER TABLE "instance_hooks" ALTER COLUMN "action_type" SET DEFAULT 'function';

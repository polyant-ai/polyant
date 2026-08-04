-- Rename the persisted platform-admin role value: 'superadmin' -> 'platform_admin'.
--
-- `users.role` is plain `text` with NO CHECK constraint and NO enum type, so the
-- data change is the whole schema change — there is nothing to ALTER. Verified
-- against the column definition in `auth/users.schema.ts` and against 0051, which
-- created neither a constraint nor a domain for it.
--
-- Idempotent: the UPDATE is scoped by the old value, so a second run matches zero
-- rows. Safe to re-run, and safe to run against a database that never held the
-- old value.
--
-- ORDERING NOTE: the application code that ACCEPTS both spellings on read
-- (`auth/user-role.ts`) ships in the same release as this migration and must never
-- ship after it. During a rolling deploy, old code reading 'platform_admin' would
-- classify a platform admin as a plain user.

UPDATE users
SET role = 'platform_admin', updated_at = now()
WHERE role = 'superadmin';

-- `is_platform_admin` is DERIVED from the role at write time (`users.store.ts`)
-- and was backfilled from it by 0051, so renaming the role value must not change
-- which accounts hold the flag — and it does not: the UPDATE above touches `role`
-- only.
--
-- That is an assumption about live data, not a guarantee the schema enforces
-- (nothing stops a direct SQL write from putting the two out of step), so rather
-- than assert it in a comment this reconciles it. Both directions, because either
-- one is wrong: a platform-admin role without the flag is an admin who has lost
-- every power the flag grants, and the flag without the role is a total bypass of
-- the permission guard held by an account the UI renders as an ordinary user.
--
-- Scoped to `role`/`is_platform_admin` disagreements, so it is a no-op on a
-- consistent database and idempotent on a second run.
UPDATE users
SET is_platform_admin = (role = 'platform_admin'), updated_at = now()
WHERE is_platform_admin <> (role = 'platform_admin');

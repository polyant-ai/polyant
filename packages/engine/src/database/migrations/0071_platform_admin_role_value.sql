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

-- Grant the flag to anyone whose role says platform admin but whose flag does
-- not. PROMOTE ONLY — this deliberately never clears the flag.
--
-- An earlier version reconciled BOTH directions
-- (`SET is_platform_admin = (role = 'platform_admin')`), on the premise that the
-- flag is always DERIVED from the role at write time and only "a direct SQL
-- write" could separate them. That premise is wrong about this codebase:
-- `promotePlatformAdminByEmail` — the documented `PLATFORM_ADMIN_EMAIL` boot
-- path — used to set the flag WITHOUT the role, so `role='user'` plus
-- `is_platform_admin=true` was a legitimate state the engine produced itself.
--
-- Reconciling downwards therefore REVOKED platform admin from exactly the
-- accounts promoted that way, silently, with nothing to restore it: where the
-- env var was still set the next boot re-promoted and hid the damage, and where
-- it had been unset (which the config documents as safe) the deployment simply
-- had no platform admin any more.
--
-- The write path is fixed too — it now sets role AND flag together — but this
-- stays promote-only regardless: a migration that can remove the last
-- administrator's access has no business guessing.
UPDATE users
SET is_platform_admin = true, updated_at = now()
WHERE role = 'platform_admin' AND is_platform_admin = false;

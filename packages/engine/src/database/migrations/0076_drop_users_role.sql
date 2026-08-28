-- `users.role` and `users.is_platform_admin` were two representations of the
-- same fact: the latter DERIVED from the former at write time, with no
-- database constraint keeping them in sync. From here on the boolean column
-- is the sole authority, read from the DB on every request.
--
-- ORDERING NOTE: the code that stops reading `role` (RoleGuard deleted, the
-- JWT claim replaced, the users API converted) ships in the SAME release and
-- never after this migration. During a rolling deploy, old code that finds
-- the column missing fails on every SELECT of the users table.

-- Final reconciliation before the drop: a row promoted via a direct UPDATE to
-- `role` alone, and never to the flag, would otherwise lose every power it has,
-- silently, the moment the column disappears. Scoped to disagreements only, so
-- this is a no-op on a consistent database and idempotent on a second run.
UPDATE users
SET is_platform_admin = true, updated_at = now()
WHERE is_platform_admin = false
  AND role IN ('platform_admin', 'superadmin');

ALTER TABLE users DROP COLUMN IF EXISTS role;

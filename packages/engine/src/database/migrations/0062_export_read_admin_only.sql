-- A full-config export enumerates secret key names, which SECRET_READ gates to
-- admins. EXPORT_READ moved from member to admin-only in the permission matrix
-- (issue #145). owner/admin were seeded with the row already (0051), so only
-- the stale member grant is removed here.
DELETE FROM "role_permissions" rp
USING "roles" r
WHERE rp."role_id" = r."id"
  AND r."is_system" = true
  AND r."key" = 'member'
  AND rp."permission" = 'agent.export:read';

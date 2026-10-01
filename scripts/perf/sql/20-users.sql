-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Users for load tests: per perf organization one org admin and four
-- workspace members, plus one platform admin. Sessions are minted offline
-- (mint-sessions.mjs), so no password is needed.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO users (email, name, is_platform_admin)
SELECT 'perf-u' || u || '@' || o.slug || '.local', 'Perf user ' || u, false
FROM organizations o, generate_series(1, 5) u WHERE o.slug LIKE 'perf-org-%';
INSERT INTO users (email, name, is_platform_admin) VALUES ('perf-platform@perf.local', 'Perf platform admin', true);

INSERT INTO organization_memberships (organization_id, user_id)
SELECT o.id, u.id FROM users u JOIN organizations o ON u.email LIKE 'perf-u%@' || o.slug || '.local';

-- u1 = org admin; u2..u5 = member of workspace ((n-2) % 3) + 1.
INSERT INTO role_bindings (user_id, role_id, scope_type, scope_id, organization_id)
SELECT u.id, r.id, 'organization', o.id, o.id
FROM users u JOIN organizations o ON u.email = 'perf-u1@' || o.slug || '.local'
JOIN roles r ON r.key = 'admin' AND r.organization_id IS NULL;

INSERT INTO role_bindings (user_id, role_id, scope_type, scope_id, organization_id)
SELECT u.id, r.id, 'workspace', w.id, o.id
FROM organizations o
CROSS JOIN generate_series(2, 5) n
JOIN users u ON u.email = 'perf-u' || n || '@' || o.slug || '.local'
JOIN workspaces w ON w.organization_id = o.id AND w.slug = 'perf-ws-' || (((n - 2) % 3) + 1)
JOIN roles r ON r.key = 'member' AND r.organization_id IS NULL
WHERE o.slug LIKE 'perf-org-%';

COMMIT;

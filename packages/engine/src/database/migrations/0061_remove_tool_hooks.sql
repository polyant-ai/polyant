-- Hook system migrated from tool actions to function actions. The tool
-- action_config shape ({toolName,args}) is incompatible with the new
-- {functionName} shape, so stale tool hooks are removed (operators
-- reconfigure them as hook functions). action_type is a plain varchar with
-- no CHECK constraint / enum, so the DELETE is the whole migration; the
-- column default flips to 'function' in the Drizzle schema (app-level only).
DELETE FROM "instance_hooks" WHERE "action_type" = 'tool';

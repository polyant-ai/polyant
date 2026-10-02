-- The HubSpot, GitHub, Render and Markdown-to-PDF tools moved into plugins and
-- now register under namespaced names. Without this migration the boot sync
-- prunes the old flat catalog rows, and `instance_tools` and `skill_tools`
-- cascade with them: every agent loses the enablement and every skill its link,
-- silently. Renaming the row in place keeps both. While the plugin is not
-- installed, the sync keeps a namespaced row that an agent has enabled, and the
-- registry offers no tool by that name, so nothing runs until the plugin is
-- loaded.
--
-- When the namespaced row already exists (a plugin was loaded before this
-- migration ran), the links move onto it and the old row goes.
--
-- The same pairs live in agents/tools/renamed-tools.ts; a test holds them equal.
DO $$
DECLARE
  pair text[];
  old_id uuid;
  new_id uuid;
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['ghIssue', 'github:issue'],
    ['ghPR', 'github:pr'],
    ['gitCloneRepo', 'github:cloneRepo'],
    ['renderService', 'render:renderService'],
    ['hubspotContact', 'hubspot:contact'],
    ['hubspotCreateTask', 'hubspot:createTask'],
    ['hubspotDeal', 'hubspot:deal'],
    ['hubspotFile', 'hubspot:file'],
    ['hubspotGetCompany', 'hubspot:getCompany'],
    ['hubspotMeeting', 'hubspot:meeting'],
    ['hubspotNote', 'hubspot:note'],
    ['hubspotSendEmail', 'hubspot:sendEmail'],
    ['hubspotTicket', 'hubspot:ticket'],
    ['markdownToPdf', 'extra:markdownToPdf']
  ]
  LOOP
    SELECT "id" INTO old_id FROM "tools" WHERE "name" = pair[1];
    IF old_id IS NOT NULL THEN
      SELECT "id" INTO new_id FROM "tools" WHERE "name" = pair[2];
      IF new_id IS NULL THEN
        UPDATE "tools" SET "name" = pair[2] WHERE "id" = old_id;
      ELSE
        INSERT INTO "instance_tools" ("instance_id", "tool_id", "source", "enabled_at")
          SELECT "instance_id", new_id, "source", "enabled_at" FROM "instance_tools" WHERE "tool_id" = old_id
          ON CONFLICT ("instance_id", "tool_id") DO NOTHING;
        INSERT INTO "skill_tools" ("skill_id", "tool_id")
          SELECT "skill_id", new_id FROM "skill_tools" WHERE "tool_id" = old_id
          ON CONFLICT ("skill_id", "tool_id") DO NOTHING;
        DELETE FROM "tools" WHERE "id" = old_id;
      END IF;
    END IF;

    -- A skill version names its tools in metadata.requiredTools; the prompt
    -- and the Tools tab compare those names with the enabled ones. Rename in
    -- place, keep the order, drop a duplicate the rename creates.
    UPDATE "skill_versions" sv
    SET "metadata" = jsonb_set(sv."metadata", '{requiredTools}', (
      SELECT jsonb_agg(to_jsonb(d.name) ORDER BY d.first_pos)
      FROM (
        SELECT CASE WHEN e.value = pair[1] THEN pair[2] ELSE e.value END AS name, min(e.pos) AS first_pos
        FROM jsonb_array_elements_text(sv."metadata"->'requiredTools') WITH ORDINALITY AS e(value, pos)
        GROUP BY 1
      ) d
    ))
    WHERE jsonb_typeof(sv."metadata"->'requiredTools') = 'array'
      AND sv."metadata"->'requiredTools' ? pair[1];
  END LOOP;
END $$;

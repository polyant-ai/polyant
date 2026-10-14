-- The fileUpload tool moved into the extra plugin and now registers as
-- extra:fileUpload. Same treatment as rename_extracted_tools: rename the catalog
-- row in place so agents keep the enablement and skills their links; when the
-- namespaced row already exists, the links move onto it and the old row goes.
--
-- The pair is also in agents/tools/renamed-tools.ts; a test holds them equal.
DO $$
DECLARE
  pair text[];
  old_id uuid;
  new_id uuid;
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['fileUpload', 'extra:fileUpload']
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

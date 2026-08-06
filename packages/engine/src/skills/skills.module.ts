// SPDX-License-Identifier: AGPL-3.0-or-later

import { Module } from "@nestjs/common";
import { SkillsController } from "./skills.controller.js";
import { SkillsService } from "./skills.service.js";

// NOTE: this module used to also register a second `InstanceSkillsController`
// on `api/agents/:slug/skills`, shadowing the RBAC-declared one in
// `server/instances/`. It carried no authorization decorator at all, so its
// POST/DELETE `:name` routes were an unguarded write path onto ANY agent. The
// admin panel never called them (it uses the declared `PATCH :slug/skills` and
// the `:skillSlug/*` sub-routes), so the file was deleted rather than decorated.
@Module({
  controllers: [SkillsController],
  providers: [SkillsService],
  exports: [SkillsService],
})
export class SkillsModule {}

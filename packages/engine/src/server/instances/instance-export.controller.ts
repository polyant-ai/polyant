// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Res,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import type { Response } from "express";
import { exportInstance } from "../../instances/export.service.js";
import { importNewInstance, importOverwriteInstance } from "../../instances/import.service.js";
import { findInstanceOrFail } from "./instance-helpers.js";
import { errMsg } from "./instance-helpers.js";
import { RequirePermission, Permission } from "../../authz/index.js";

@Controller("api/agents")
export class InstanceExportController {
  @RequirePermission(Permission.EXPORT_READ)
  @Get(":slug/export")
  async exportInstance(
    @Param("slug") slug: string,
    @Res() res: Response,
  ) {
    await findInstanceOrFail(slug);

    try {
      const bundle = await exportInstance(slug);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `${slug}-export-${date}.json`;

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(JSON.stringify(bundle, null, 2));
    } catch (err) {
      throw new BadRequestException(errMsg(err));
    }
  }

  @RequirePermission(Permission.AGENT_WRITE)
  @Post("import")
  async importNew(@Body() body: unknown) {
    try {
      const result = await importNewInstance(body);
      return result;
    } catch (err) {
      const message = errMsg(err);
      if (message.includes("not found")) throw new NotFoundException(message);
      throw new BadRequestException(message);
    }
  }

  @RequirePermission(Permission.AGENT_WRITE)
  @Post(":slug/import")
  async importOverwrite(
    @Param("slug") slug: string,
    @Body() body: unknown,
  ) {
    await findInstanceOrFail(slug);

    try {
      const result = await importOverwriteInstance(slug, body);
      return result;
    } catch (err) {
      const message = errMsg(err);
      if (message.includes("not found")) throw new NotFoundException(message);
      throw new BadRequestException(message);
    }
  }
}

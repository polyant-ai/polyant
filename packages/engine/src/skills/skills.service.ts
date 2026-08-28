// SPDX-License-Identifier: AGPL-3.0-or-later

import { Injectable } from "@nestjs/common";
import {
  listSkills as dbListSkills,
  getSkill as dbGetSkill,
  createSkill as dbCreateSkill,
  updateSkill as dbUpdateSkill,
  type SkillWithVersion,
  type CreateSkillInput,
  type UpdateSkillInput,
} from "./skills.store.js";
import { eq, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { skills } from "./schema.js";
import { isUniqueViolation } from "../utils/db-errors.js";

export interface SkillSummary {
  name: string;
  description: string;
  category?: string;
  requiredEnv?: Array<{ name: string; description?: string; sensitive: boolean }>;
  requiredTools?: string[];
}

export interface SkillDetail extends SkillSummary {
  content: string;
}

@Injectable()
export class SkillsService {
  /** List all active skills in the global library. */
  async listSkills(): Promise<SkillSummary[]> {
    const rows = await dbListSkills();
    return rows.map((r) => this.toSummary(r));
  }

  /** Get a single skill with full content. */
  async getSkill(slug: string): Promise<SkillDetail | null> {
    const row = await dbGetSkill(slug);
    if (!row) return null;
    return this.toDetail(row);
  }

  /** Create a new skill in the library. */
  async createSkill(data: {
    name: string;
    description: string;
    content: string;
    requiredEnv?: Array<{ name: string; description?: string; sensitive: boolean }>;
    requiredTools?: string[];
  }): Promise<SkillDetail> {
    const safeName = data.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    const metadata: Record<string, unknown> = {};
    if (data.requiredEnv) metadata.requiredEnv = data.requiredEnv;
    if (data.requiredTools) metadata.requiredTools = data.requiredTools;

    const input: CreateSkillInput = {
      slug: safeName,
      name: data.name,
      description: data.description,
      content: data.content,
      metadata,
    };

    // Rely on the DB unique constraint on skills.slug as the authoritative duplicate
    // check — a pre-select + insert would leave a TOCTOU race window.
    try {
      const created = await dbCreateSkill(input);
      return this.toDetail(created);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error(`Skill "${safeName}" already exists`, { cause: err });
      }
      throw err;
    }
  }

  /** Update an existing skill (creates a new version). */
  async updateSkill(
    slug: string,
    data: {
      description: string;
      content: string;
      requiredEnv?: Array<{ name: string; description?: string; sensitive: boolean }>;
      requiredTools?: string[];
      changelog?: string;
    },
  ): Promise<SkillDetail | null> {
    const metadata: Record<string, unknown> = {};
    if (data.requiredEnv) metadata.requiredEnv = data.requiredEnv;
    if (data.requiredTools) metadata.requiredTools = data.requiredTools;

    const input: UpdateSkillInput = {
      description: data.description,
      content: data.content,
      metadata,
      changelog: data.changelog,
    };

    const updated = await dbUpdateSkill(slug, input);
    if (!updated) return null;
    return this.toDetail(updated);
  }

  /** Soft-delete a skill (set status to 'archived'). */
  async deleteSkill(slug: string): Promise<boolean> {
    const existing = await dbGetSkill(slug);
    if (!existing) return false;

    await db
      .update(skills)
      .set({ status: "archived", updatedAt: sql`now()` })
      .where(eq(skills.slug, slug));
    return true;
  }

  // --- Private helpers ---

  private toSummary(row: SkillWithVersion): SkillSummary {
    const meta = row.currentVersion?.metadata as {
      requiredEnv?: Array<{ name: string; description?: string; sensitive: boolean }>;
      requiredTools?: string[];
    } | null;
    const summary: SkillSummary = {
      name: row.slug,
      description: row.description,
      category: row.category,
    };
    if (meta?.requiredEnv && meta.requiredEnv.length > 0) {
      summary.requiredEnv = meta.requiredEnv;
    }
    if (meta?.requiredTools && meta.requiredTools.length > 0) {
      summary.requiredTools = meta.requiredTools;
    }
    return summary;
  }

  private toDetail(row: SkillWithVersion): SkillDetail {
    const summary = this.toSummary(row);
    return {
      ...summary,
      content: row.currentVersion?.content ?? "",
    };
  }
}

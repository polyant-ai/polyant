// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LibrarySkillDetail } from "@/lib/api-types";

export function makeLibrarySkillDetail(overrides: Partial<LibrarySkillDetail> = {}): LibrarySkillDetail {
  return { name: "my-skill", displayName: "My skill", description: "Does a thing", content: "Steps", ...overrides };
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import { BadRequestException } from "@nestjs/common";
import type { z } from "zod";

/**
 * Validate a request body against its schema before the controller reads any of
 * it. A wrong type answers 400 naming the field; nothing downstream ever sees an
 * unvalidated value, so JavaScript truthiness cannot turn `"false"` into a yes.
 */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException(
      parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    );
  }
  return parsed.data;
}

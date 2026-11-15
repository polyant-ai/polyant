// SPDX-License-Identifier: AGPL-3.0-or-later

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { AgentRequestRefusedError } from "../../instances/agent-refusal.js";

/** Run domain work and answer its refusal with the matching HTTP status and the same message. */
export async function refusalsAsHttp<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof AgentRequestRefusedError) {
      if (err.kind === "not_found") throw new NotFoundException(err.message);
      if (err.kind === "conflict") throw new ConflictException(err.message);
      throw new BadRequestException(err.message);
    }
    throw err;
  }
}

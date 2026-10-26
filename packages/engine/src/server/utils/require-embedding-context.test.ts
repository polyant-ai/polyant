// SPDX-License-Identifier: AGPL-3.0-or-later

import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

const { mockResolve } = vi.hoisted(() => ({ mockResolve: vi.fn() }));
vi.mock("../../embeddings-gateway/index.js", () => ({ resolveEmbeddingContext: mockResolve }));

import { requireEmbeddingContext } from "./require-embedding-context.js";

describe("requireEmbeddingContext", () => {
  it("should_return_the_context_the_gateway_resolves", async () => {
    mockResolve.mockResolvedValue({ dimensions: 1024 });
    await expect(requireEmbeddingContext("a" as never)).resolves.toEqual({ dimensions: 1024 });
  });

  it("should_turn_the_gateway_reason_into_a_400", async () => {
    mockResolve.mockRejectedValue(new Error("no key"));
    const err = await requireEmbeddingContext("a" as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe("no key");
  });

  it("should_use_a_generic_message_for_a_non_error_rejection", async () => {
    mockResolve.mockRejectedValue("boom");
    const err = await requireEmbeddingContext("a" as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
  });
});

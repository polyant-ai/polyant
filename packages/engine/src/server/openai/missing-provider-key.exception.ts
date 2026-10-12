// SPDX-License-Identifier: AGPL-3.0-or-later

import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * The agent has no API key for its AI provider, so the turn produced a warning
 * instead of an answer. Over the OpenAI-compatible API that is a server-side
 * failure, not a completion: 503 in OpenAI's error shape. The body is a plain
 * object, so the global filter passes it through verbatim.
 */
export class MissingProviderKeyException extends HttpException {
  constructor(message: string) {
    super(
      { error: { message, type: "server_error", param: null, code: "missing_provider_key" } },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/** Retrying cannot fix a missing key; OpenAI SDKs honour this header and stop retrying a 503. */
export const SHOULD_NOT_RETRY_HEADER = "x-should-retry";

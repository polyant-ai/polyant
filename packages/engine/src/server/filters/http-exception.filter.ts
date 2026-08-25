// SPDX-License-Identifier: AGPL-3.0-or-later

import { ExceptionFilter, Catch, ArgumentsHost, HttpException } from "@nestjs/common";
import type { Request, Response } from "express";
import { redactWebhookPath } from "./redact-webhook-path.js";

/** A response body shaped like NestJS's default HttpException JSON payload. */
interface ErrorResponseBody {
  statusCode: number;
  message: string;
  error?: string;
}

interface HandledError {
  status: number;
  body: ErrorResponseBody | Record<string, unknown>;
}

/**
 * Log and answer an `HttpException` as-is: status and body are preserved
 * verbatim (NestJS exceptions are already client-safe by construction).
 */
function handleHttpException(exception: HttpException, method: string, path: string): HandledError {
  const status = exception.getStatus();
  const body = exception.getResponse();
  console.error(`[${method}] ${path} -> ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return {
    status,
    body: typeof body === "string" ? { statusCode: status, message: body } : (body as Record<string, unknown>),
  };
}

/**
 * TypeError / RangeError almost always indicate a malformed request body
 * (wrong shape, missing key, wrong types) hitting a controller that assumed
 * the right shape. Surfaced as 400 with a GENERIC client message — the raw
 * `.message` can include internal property paths (`Cannot read properties
 * of undefined (reading 'sections')`), which is information disclosure that
 * aids endpoint enumeration. The real message is logged server-side only.
 */
function handleValidationError(exception: TypeError | RangeError, method: string, path: string): HandledError {
  console.warn(`[${method}] ${path} -> 400 (validation): ${exception.message}`);
  return {
    status: 400,
    body: { statusCode: 400, message: "Invalid request body", error: "Bad Request" },
  };
}

/** Unknown error — logged server-side in full, never leaked to the client. */
function handleUnknownError(exception: unknown, method: string, path: string): HandledError {
  const errorMessage = exception instanceof Error ? exception.message : String(exception);
  console.error(`[${method}] ${path} -> 500 (unhandled): ${errorMessage}`);
  return {
    status: 500,
    body: { statusCode: 500, message: "Internal server error" },
  };
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const method = request.method;
    // Webhook routes carry their sole authentication credential in the path
    // itself (a Twilio API-Key-mode secret, a Room event-source token), and
    // this filter's log lines are teed to a plaintext, 14-day-retention log
    // file by `installFileLogger()` — so the path must be redacted before it
    // is ever interpolated into a log line, in EVERY branch below.
    const path = redactWebhookPath(request.url);

    const { status, body } = this.resolve(exception, method, path);
    response.status(status).json(body);
  }

  /** Dispatch to the branch-specific handler and shape the response body. */
  private resolve(exception: unknown, method: string, path: string): HandledError {
    if (exception instanceof HttpException) {
      return handleHttpException(exception, method, path);
    }
    if (exception instanceof TypeError || exception instanceof RangeError) {
      return handleValidationError(exception, method, path);
    }
    return handleUnknownError(exception, method, path);
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import { ExceptionFilter, Catch, ArgumentsHost, HttpException } from "@nestjs/common";
import type { Request, Response } from "express";
import { redactWebhookPath } from "./redact-webhook-path.js";

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

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      console.error(`[${method}] ${path} -> ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
      response.status(status).json(
        typeof body === "string" ? { statusCode: status, message: body } : body,
      );
      return;
    }

    // TypeError / RangeError almost always indicate a malformed request body
    // (wrong shape, missing key, wrong types) hitting a controller that
    // assumed the right shape. Surface it as 400 — but with a GENERIC client
    // message. The raw `.message` field can include internal property paths
    // (`Cannot read properties of undefined (reading 'sections')`) which is
    // information disclosure that aids endpoint enumeration. Log the real
    // message server-side at warn level instead.
    if (exception instanceof TypeError || exception instanceof RangeError) {
      console.warn(`[${method}] ${path} -> 400 (validation): ${exception.message}`);
      response.status(400).json({
        statusCode: 400,
        message: "Invalid request body",
        error: "Bad Request",
      });
      return;
    }

    // Unknown error — do not leak internals
    const errorMessage = exception instanceof Error ? exception.message : String(exception);
    console.error(`[${method}] ${path} -> 500 (unhandled): ${errorMessage}`);

    response.status(500).json({
      statusCode: 500,
      message: "Internal server error",
    });
  }
}

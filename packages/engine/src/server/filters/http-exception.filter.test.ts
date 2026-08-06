// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { HttpException, BadRequestException, NotFoundException } from "@nestjs/common";
import { GlobalExceptionFilter } from "./http-exception.filter.js";

function createMockHost(mockResponse: any, mockRequest: any) {
  return {
    switchToHttp: () => ({
      getResponse: () => mockResponse,
      getRequest: () => mockRequest,
    }),
  } as any;
}

function createMockResponse() {
  const res: any = {
    statusCode: 0,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: any) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function createMockRequest(method = "GET", url = "/test") {
  return { method, url } as any;
}

describe("GlobalExceptionFilter", () => {
  const filter = new GlobalExceptionFilter();

  it("returns HttpException status and message as-is (string body)", () => {
    const res = createMockResponse();
    const host = createMockHost(res, createMockRequest("POST", "/api/test"));

    filter.catch(new HttpException("Not allowed", 403), host);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ statusCode: 403, message: "Not allowed" });
  });

  it("returns HttpException with object body as-is", () => {
    const res = createMockResponse();
    const host = createMockHost(res, createMockRequest());

    filter.catch(new BadRequestException("Invalid input"), host);

    expect(res.statusCode).toBe(400);
    expect(res.body.statusCode).toBe(400);
    expect(res.body.message).toBe("Invalid input");
  });

  it("preserves NotFoundException status", () => {
    const res = createMockResponse();
    const host = createMockHost(res, createMockRequest());

    filter.catch(new NotFoundException("Resource not found"), host);

    expect(res.statusCode).toBe(404);
  });

  it("returns 500 with generic message for unknown Error (no details leaked)", () => {
    const res = createMockResponse();
    const host = createMockHost(res, createMockRequest("GET", "/secret"));

    filter.catch(new Error("sensitive database connection string"), host);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      statusCode: 500,
      message: "Internal server error",
    });
    // Ensure the sensitive info is NOT in the response
    expect(JSON.stringify(res.body)).not.toContain("sensitive");
    expect(JSON.stringify(res.body)).not.toContain("database");
  });

  it("returns 500 with generic message for non-Error throw", () => {
    const res = createMockResponse();
    const host = createMockHost(res, createMockRequest());

    filter.catch("some string error", host);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      statusCode: 500,
      message: "Internal server error",
    });
  });

  it("returns 400 (not 500) when a controller throws TypeError (body shape mismatch)", () => {
    const res = createMockResponse();
    const host = createMockHost(res, createMockRequest("POST", "/api/agents"));

    // Simulate `body.items.map(...)` when body.items is undefined. The filter
    // surfaces a generic message to avoid leaking internal property paths.
    filter.catch(new TypeError("Cannot read properties of undefined (reading 'map')"), host);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      statusCode: 400,
      message: "Invalid request body",
      error: "Bad Request",
    });
  });

  it("returns 400 (not 500) when a controller throws RangeError", () => {
    const res = createMockResponse();
    const host = createMockHost(res, createMockRequest("POST", "/api/test"));

    filter.catch(new RangeError("Invalid array length"), host);

    expect(res.statusCode).toBe(400);
    expect(res.body.statusCode).toBe(400);
    expect(res.body.error).toBe("Bad Request");
    expect(res.body.message).toBe("Invalid request body");
  });

  it("returns 500 for thrown object", () => {
    const res = createMockResponse();
    const host = createMockHost(res, createMockRequest());

    filter.catch({ weird: "object" }, host);

    expect(res.statusCode).toBe(500);
    expect(res.body.message).toBe("Internal server error");
  });
});

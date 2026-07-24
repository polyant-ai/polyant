import { describe, it, expect } from "vitest";
import { ManagementAuditAction, ManagementAuditTarget } from "./management-audit-logger.js";

describe("management-audit mcp constants", () => {
  it("should_expose_mcp_server_action_and_target", () => {
    expect(ManagementAuditAction.McpServerWrite).toBe("mcp_server.write");
    expect(ManagementAuditAction.McpServerDelete).toBe("mcp_server.delete");
    expect(ManagementAuditTarget.McpServer).toBe("mcp_server");
  });
});

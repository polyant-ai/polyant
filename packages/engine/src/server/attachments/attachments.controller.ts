// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Param, Res, NotFoundException, Inject } from "@nestjs/common";
import type { Response } from "express";
import { getAttachmentStream, isPlatformStorageConfigured } from "../../attachments/platform-storage.js";
import { AuthorizationService } from "../../authz/authorization.service.js";
import { resolvePrincipalOrgId } from "../../instances/store.js";
import { RequirePermission, Permission } from "../../authz/index.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import { createLogger } from "../../utils/create-logger.js";

/** Expected key format: attachments/{agentSlug}/{conversationId}/{filename} */
const KEY_PATTERN = /^attachments\/[^/]+\/[^/]+\/[^/]+$/;

const logger = createLogger();
const LOG_PREFIX = "attachments";

/**
 * The principals AuthGuard can put on the request for this route: a human or
 * management-key identity (org-scoped) or a per-instance API key (agent-scoped).
 * Declared locally because `AuthenticatedUser` models only the human variant.
 */
interface AttachmentCaller {
  readonly kind?: "instance";
  readonly instanceSlug?: string;
  readonly orgId?: string;
}

/** One 404 for every denial reason, so none of them is distinguishable. */
function notFound(): NotFoundException {
  return new NotFoundException("Attachment not found");
}

@Controller("api/attachments")
export class AttachmentsController {
  constructor(
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
  ) {}

  /**
   * Proxy endpoint for serving conversation attachments from platform S3.
   * The s3Key is the full path under the bucket: attachments/{agentSlug}/{conversationId}/{filename}
   */
  @RequirePermission(Permission.CONVERSATION_READ)
  @Get("*key")
  async getAttachment(
    @Param("key") s3Key: string,
    @Res() res: Response,
    @CurrentUser() caller?: AttachmentCaller,
  ): Promise<void> {
    if (!isPlatformStorageConfigured()) {
      throw new NotFoundException("Attachment storage not configured");
    }

    // Security: reject path traversal and enforce expected key structure
    if (s3Key.includes("..") || !KEY_PATTERN.test(s3Key)) {
      throw new NotFoundException("Invalid attachment key");
    }

    // Tenancy check BEFORE any S3 read — see assertCallerOwnsAgent.
    await this.assertCallerOwnsAgent(s3Key.split("/")[1], caller);

    try {
      const { body, contentType, contentLength } = await getAttachmentStream(s3Key);

      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      if (contentLength != null) {
        res.setHeader("Content-Length", contentLength);
      }

      // Extract filename for Content-Disposition
      const fileName = s3Key.split("/").pop();
      if (fileName) {
        const disposition = contentType.startsWith("image/") ? "inline" : "attachment";
        res.setHeader("Content-Disposition", `${disposition}; filename="${fileName}"`);
      }

      // Pipe the S3 stream to the HTTP response with error handling
      const nodeStream = body as NodeJS.ReadableStream;
      nodeStream.on("error", () => {
        if (!res.headersSent) {
          res.status(500).send("Stream error");
        } else {
          res.end();
        }
      });
      nodeStream.pipe(res);
    } catch {
      throw new NotFoundException("Attachment not found");
    }
  }

  /**
   * Cross-org IDOR gate (issue #133). The route param is named `key`, not
   * `slug`, so PermissionGuard resolves no agent scope: it authorizes the caller
   * at its own org level and nothing ties the agent slug embedded in the key to
   * the caller's tenancy. `getAttachmentStream` is a raw GetObject with no
   * scoping either, so this handler is the only place the check can happen.
   *
   * Always 404, never 403: a caller of another organization must not learn
   * whether the attachment — or the agent — exists.
   */
  private async assertCallerOwnsAgent(
    agentSlug: string,
    caller: AttachmentCaller | undefined,
  ): Promise<void> {
    // A per-instance API key acts only for its own agent — the same rule
    // PermissionGuard applies to an instance principal on a `:slug` route. It
    // carries no org, so the slug alone decides.
    if (caller?.kind === "instance") {
      if (caller.instanceSlug !== agentSlug) throw notFound();
      return;
    }

    // Everyone else (human session, ALB identity, management API key) is decided
    // on the organization. `resolvePrincipalOrgId` is the shared rule used by the
    // agent create/list paths: an explicit claim wins; with no claim, a
    // single-org deployment is unambiguous (ALB identities and pre-RBAC JWTs
    // carry none); anything else fails closed — ownership is unprovable.
    const orgId = await resolvePrincipalOrgId(caller?.orgId);
    if (!orgId) throw notFound();

    let organizationId: string | undefined;
    try {
      organizationId = (await this.authz.resolveAgentScope(agentSlug))?.organizationId;
    } catch (err) {
      // Fail closed on a lookup failure rather than serving an unverified object.
      logger.error(LOG_PREFIX, `agent scope lookup failed for "${agentSlug}"`, err);
      throw notFound();
    }

    // Unknown agent and foreign agent are deliberately indistinguishable.
    // No platform-admin bypass: the other org-scoped read paths (conversations,
    // analytics, audit) do not grant one either.
    if (organizationId !== orgId) throw notFound();
  }
}

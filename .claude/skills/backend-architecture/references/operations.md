# Operations: logging, audit, room, webhooks, scheduling

Moved out of `CLAUDE.md` verbatim: the invariants stayed there, this is the reasoning
and the detail behind them. Read the entry in CLAUDE.md first — it says what the rule
IS; this file says why, and what breaks when it is ignored.

- **Logging verbosity (`LOG_LEVEL`)**: the shared logger factory (`utils/create-logger.ts`) gates output by level (`debug | info | warn | error | silent`, default `info`) via the exported `shouldLog(level)`. `info` keeps the high-value pipeline skeleton (request, LLM token/latency, tool results, supervisor + response timing); `debug` adds verbose per-step tracing (LLM call lines, tool-call args, system-prompt **length only**, context load). The full system prompt is **never** logged — full-payload inspection is the per-instance `debug_enabled` flag, which PERSISTS the prompt, messages and tool definitions (`LlmDebugPayload`) rather than printing them; the `DEBUG_LLM_PAYLOAD` env that used to dump a truncated copy to stdout is gone, and so is the raw provider error body it gated — `logProviderError` now logs the body's LENGTH plus its machine-readable error type (`errorBodyReason`), never the free text that can quote the offending content back. `LOG_LEVEL` is read directly from `process.env` (CONVENTION-EXCEPTION) so the foundational logger never depends on the Zod `config` graph (which would invert layering and break partial `config`/`fs` test mocks). The file logger (`utils/file-logger.ts`) tees `console.*` to daily files and strips ANSI color codes so on-disk logs stay plain-text and grep-able. Tests run at `LOG_LEVEL=debug` (set in `test-setup.ts`)

- **Management write-audit log** (`packages/engine/src/management-audit/`, RBAC Stream 7): destructive management-plane mutations (`agent.create`/`agent.delete`, `secret.write`/`secret.delete`, `member.remove`) leave a forensic row in `management_audit_logs` carrying actor (`actor_user_id` + `actor_email`, both nullable for gateway/edge identities) + target (`target_type` + free-form `target_id`, FK-free so rows survive target deletion) + action. Controllers obtain the actor via `@CurrentUser()` and call `createManagementAuditLogger().log({ action, actor, targetType, targetId })`; actions and target types are closed-set constants (`ManagementAuditAction` / `ManagementAuditTarget`) — never magic strings. The secret VALUE is never audited (key only). The buffered `ManagementAuditStore` (init/shutdown wired in `index.ts`, batch on 10 / flush 5s, re-buffer-on-failure capped) mirrors the AI-runtime `AuditStore`. **Distinct from** the EE `authz_audit_logs` (authorization read/access — has NO OSS write path, guarded by a regression test) and the AI-runtime `tool_audit_logs` (per-tool-call pipeline audit). `member.remove` constant exists ahead of its (later RBAC stream) OSS endpoint.

## Important Caveats

- **Room is event-driven, not conversational**: the Room scheduler processes pending events on a 30s tick, not on user messages. Each cycle creates a **new conversation** (`room:{instanceId}:{timestamp}`) — never persistent. Human replies on the outbound channel trigger an immediate cycle via `triggerImmediate()`

- **Event matching uses LLM tier "fast"**: sequential evaluation, first match wins. Definitions are priority-ordered

- **Room scheduler is a singleton** (`roomScheduler`) with per-room mutex via a `running` Set. Multiple rooms process in parallel, but the same room never runs concurrently. The tick uses a batch query (`countPendingByInstance`) to avoid N+1

- **Webhook receiver always returns 200 OK** — processing is fire-and-forget. Events are dropped (not queued) if backlog cap (100) is reached. Payloads are limited to 64KB

- **Event source operations are instance-scoped**: all event source and definition mutations verify ownership via `instanceId` — event sources directly in the WHERE clause, definitions via `verifyEventSourceOwnership()` which confirms the parent event source belongs to the instance. The `mark_events_completed` harness tool also scopes by `instanceId`. This prevents IDOR across instances

- **Title generation is shared**: `packages/engine/src/utils/title-generator.ts` provides `generateConversationTitle()` used by both the main pipeline (`index.ts`) and the room engine. Never duplicate the title prompt inline

- **`gitCloneRepo` credential lifecycle (#87)**: the GitHub token and the credential helper are written to `.git/polyant-token` (mode 0600) and `.git/polyant-askpass.sh` (mode 0700) inside each cloned workspace so that subsequent git operations (push/fetch by Claude Code) can authenticate. Both files are removed automatically by `cleanupRepo()` when the conversation ends and by `cleanupStaleRepos()` (stale threshold: 2h). **Trade-off**: while the workspace exists, the token is at rest on disk. Workspaces must be treated as ephemeral sandbox state: never backup/rsync/tar/commit them, never expose `workspaces/<instanceId>/` via any external share. A warning is logged if a leftover `.git/polyant-token` is detected during stale cleanup — that signals a crashed prior run


## Object storage: the agent's bucket, and the credential mode

`PLATFORM_S3_BUCKET` and its three companions were the deployment's answer to
"where do attachments go": one bucket for every tenant on the installation,
configured by an environment variable **no deployment ever set** — so no
attachment was ever stored, on any installation, and the panel's attachment view
could not render. The tier was wrong as well as unused: a bucket is something a
tenant owns, alongside the credentials that reach it.

It is now the agent's, from the secrets `fileUpload` already declared —
`s3_bucket_name` and `aws_region`, plus one of two credential shapes — and
`attachments/agent-s3.ts` resolves it for both the tool and attachment
persistence. One bucket per agent, so the two can never disagree about where an
agent's files live.

**The credential mode is decided explicitly, and the four branches are not
symmetric:**

- both static keys present → use them
- exactly ONE present → a configuration error. Falling through to the task role
  would mask the missing half AND perform the write under an identity nobody
  chose for that agent
- neither, with `s3_use_task_role` → the default provider chain, i.e. the ECS
  task role, for a bucket whose policy trusts that role
- neither, without the opt-in → refuse. The task role is a SHARED identity:
  reaching it has to be a per-agent decision, or one agent's write lands under
  an identity that belongs to the installation

`s3_endpoint` targets an S3-compatible server (MinIO, Cloudflare R2) and also
switches the client to **path-style** addressing: those servers do not resolve
bucket-as-subdomain, so the SDK's virtual-host default reaches a host that does
not exist. The `fileUpload` tool builds its returned URL the same way, or it
would hand back a link nobody can open.

**Two things worth knowing before relying on any of this.** The bytes never
gated the agent's own sight of an attachment — they reach the model inline — so
storage decides only whether a file can be reopened afterwards. And stored
objects are NOT covered by `retention/purge.store.ts`: they outlive the
conversation rows that reference them, which is known, unfixed, and worse
per-agent than it was per-platform, because an erasure now has to reach N
buckets whose credentials live in N encrypted rows.

The client is cached per agent, so `instance-secrets.controller.ts` calls
`invalidateAgentS3` on every write and delete: a rotated key would otherwise keep
failing against a credential nobody is using any more, until a restart.

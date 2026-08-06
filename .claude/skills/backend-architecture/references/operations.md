# Operations: logging, audit, room, webhooks, scheduling

Moved out of `CLAUDE.md` verbatim: the invariants stayed there, this is the reasoning
and the detail behind them. Read the entry in CLAUDE.md first — it says what the rule
IS; this file says why, and what breaks when it is ignored.

- **Logging verbosity (`LOG_LEVEL`)**: the shared logger factory (`utils/create-logger.ts`) gates output by level (`debug | info | warn | error | silent`, default `info`) via the exported `shouldLog(level)`. `info` keeps the high-value pipeline skeleton (request, LLM token/latency, tool results, supervisor + response timing); `debug` adds verbose per-step tracing (LLM call lines, tool-call args, system-prompt **length only**, context load). The full system prompt is **never** logged — use the per-instance `debug_enabled` flag or `DEBUG_LLM_PAYLOAD` for full-payload inspection. `LOG_LEVEL` is read directly from `process.env` (CONVENTION-EXCEPTION) so the foundational logger never depends on the Zod `config` graph (which would invert layering and break partial `config`/`fs` test mocks). The file logger (`utils/file-logger.ts`) tees `console.*` to daily files and strips ANSI color codes so on-disk logs stay plain-text and grep-able. Tests run at `LOG_LEVEL=debug` (set in `test-setup.ts`)

- **Management write-audit log** (`packages/engine/src/management-audit/`, RBAC Stream 7): destructive management-plane mutations (`agent.create`/`agent.delete`, `secret.write`/`secret.delete`, `member.remove`) leave a forensic row in `management_audit_logs` carrying actor (`actor_user_id` + `actor_email`, both nullable for gateway/edge identities) + target (`target_type` + free-form `target_id`, FK-free so rows survive target deletion) + action. Controllers obtain the actor via `@CurrentUser()` and call `createManagementAuditLogger().log({ action, actor, targetType, targetId })`; actions and target types are closed-set constants (`ManagementAuditAction` / `ManagementAuditTarget`) — never magic strings. The secret VALUE is never audited (key only). The buffered `ManagementAuditStore` (init/shutdown wired in `index.ts`, batch on 10 / flush 5s, re-buffer-on-failure capped) mirrors the AI-runtime `AuditStore`. **Distinct from** the EE `authz_audit_logs` (authorization read/access — has NO OSS write path, guarded by a regression test) and the AI-runtime `tool_audit_logs` (per-tool-call pipeline audit). `member.remove` constant exists ahead of its (later RBAC stream) OSS endpoint.

## Important Caveats

- **Room is event-driven, not conversational**: the Room scheduler processes pending events on a 30s tick, not on user messages. Each cycle creates a **new conversation** (`room:{instanceId}:{timestamp}`) — never persistent. Human replies on the outbound channel trigger an immediate cycle via `triggerImmediate()`

- **Event matching uses LLM tier "fast"**: sequential evaluation, first match wins. Definitions are priority-ordered

- **Room scheduler is a singleton** (`roomScheduler`) with per-room mutex via a `running` Set. Multiple rooms process in parallel, but the same room never runs concurrently. The tick uses a batch query (`countPendingByInstance`) to avoid N+1

- **Webhook receiver always returns 200 OK** — processing is fire-and-forget. Events are dropped (not queued) if backlog cap (100) is reached. Payloads are limited to 64KB

- **Event source operations are instance-scoped**: all event source and definition mutations verify ownership via `instanceId` — event sources directly in the WHERE clause, definitions via `verifyEventSourceOwnership()` which confirms the parent event source belongs to the instance. The `mark_events_completed` harness tool also scopes by `instanceId`. This prevents IDOR across instances

- **Title generation is shared**: `packages/engine/src/utils/title-generator.ts` provides `generateConversationTitle()` used by both the main pipeline (`index.ts`) and the room engine. Never duplicate the title prompt inline

- **`gitCloneRepo` credential lifecycle (#87)**: the GitHub token and the credential helper are written to `.git/polyant-token` (mode 0600) and `.git/polyant-askpass.sh` (mode 0700) inside each cloned workspace so that subsequent git operations (push/fetch by Claude Code) can authenticate. Both files are removed automatically by `cleanupRepo()` when the conversation ends and by `cleanupStaleRepos()` (stale threshold: 2h). **Trade-off**: while the workspace exists, the token is at rest on disk. Workspaces must be treated as ephemeral sandbox state: never backup/rsync/tar/commit them, never expose `workspaces/<instanceId>/` via any external share. A warning is logged if a leftover `.git/polyant-token` is detected during stale cleanup — that signals a crashed prior run

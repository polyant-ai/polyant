# WhatsApp interactive templates in the inbound chat — design

**Date:** 2026-07-24
**Status:** approved (brainstorming) — implementation pending
**Related:** `packages/engine/src/agents/tools/send-whatsapp-template.tool.ts`, `packages/engine/src/channels/adapters/whatsapp/`, `packages/engine/src/index.ts`, `packages/engine/src/webhooks/webhook-engine.ts`

## 1. Problem

An instance running on WhatsApp cannot reply to a live user with an interactive
message (quick-reply buttons or a list picker). Today the only path to a
WhatsApp interactive message is the `send_whatsapp_template` tool, and it is
usable **only inside a webhook-triggered (proactive) conversation**. In a normal
inbound chat — the user messages the bot, the bot replies within the open 24h
customer-service window — the agent has no way to send a list/buttons; it can
only produce free-form text.

The concrete target use case: the instance has a small number of **pre-created
Twilio Content templates** (e.g. two list-picker variants that share the same
body text). The instance prompt instructs the agent to call the template tool
with the appropriate `contentSid` depending on the situation. Because the reply
happens inside the open 24h window, the templates do **not** need WhatsApp
approval (verified live: unapproved Content list-pickers are delivered in-session).

## 2. Goal / scope

Make `send_whatsapp_template` usable from a **live inbound WhatsApp conversation**,
so the agent can reply with a pre-created interactive Content template, and so
that template — not the LLM free-form text — is what is delivered and persisted.

In scope:

- Equip the template tool in the inbound (non-webhook) conversational path.
- Let the tool resolve the outbound target from the current channel identity
  when there is no webhook trigger context.
- Deliver exactly one message and persist the rendered template body (with its
  options) as the assistant turn.

## 3. Non-goals

- **Dynamic Content creation.** No building/creating Content templates at
  runtime. Templates are pre-created out-of-band in Twilio; the agent only
  references a `contentSid`. (A dynamic-list variant was considered and
  deferred — it adds runtime Content creation plus a template-lifecycle concern
  with no benefit for the fixed-list use case.)
- **Out-of-session initiation.** Sending outside the 24h window still requires an
  approved template via the existing proactive/webhook path. Unchanged.
- **Cross-channel interactive abstraction.** No generic `sendInteractive` on the
  `ChannelAdapter` interface, no Telegram/Slack rendering. WhatsApp only. YAGNI
  until a second channel needs it.
- **A new tool.** We reuse and generalize `send_whatsapp_template`.

## 4. Current state (what already works, what blocks)

Already built and reused as-is:

- **History rendering including options.** `getTemplateBody` →
  `renderTemplateBody` (`render-template.ts`) renders the template body plus each
  option as `[Button: <label>]` lines, and `collectActionLabels` (`twilio-client.ts`)
  collects both quick-reply `actions` and list-picker `items`. So the tool's
  `replyText` already carries the full list — exactly the history coherence we
  want.
- **Opt-out suppression** inside `channelManager.sendOutboundTemplate`.
- **In-session delivery of unapproved Content** (verified live).
- **`replyHandled`/`replyText` honoring in the webhook path**
  (`webhook-engine.ts`): the proven precedent for what fix 3 ports to inbound.

Three blockers in the inbound path:

1. **The tool is not equipped.** `handleMessage` → `runBufferedTurn` → `supervise`
   passes no `includeHarness`, so every `harness: true` tool — including
   `send_whatsapp_template` (category `"whatsapp"`) — is skipped
   (`supervisor/index.ts`, the `if (def.harness && !isHarnessIncluded) continue`
   gate). Only the webhook engine (`new Set([outboundChannel, "conversation-trigger"])`)
   and the room engine (`new Set(["room"])`) inject harness tools.
2. **The tool is gated to the trigger context.** Its first step is
   `getTriggerContext(ctx.conversationId)`, which is null in a normal chat, so it
   returns `"No active trigger context"` before sending anything.
3. **`replyHandled` is not wired in the inbound path.** `runBufferedTurn` always
   delivers `replayText` (the LLM text) and ignores `result.replyHandled`, so a
   tool-delivered template would produce a second (redundant) text message and
   the persisted assistant turn would be the LLM text, not the template body.

## 5. Design — the three fixes

### Fix 1 — equip channel-category harness tools in the inbound path

In `runBufferedTurn` (the non-streamed buffered turn used by WhatsApp inbound),
derive `includeHarness` from the inbound channel type and pass it into
`superviseArgs`:

```
includeHarness: new Set([msg.channelType])
```

A harness tool is equipped iff its `category` is in the set. Today only
`send_whatsapp_template` (category `"whatsapp"`) matches, and only when
`msg.channelType === "whatsapp"`. For `web`/`telegram`/`slack` there is no
matching harness tool, so the change is a no-op for them. This mirrors the
webhook engine's channel-keyed harness gating and stays generic (a future
channel-specific harness send tool auto-appears on that channel).

We deliberately keep this generic rather than gating it behind an explicit
allow-list of categories: the channel-type key is already the constraint, and a
new channel-specific harness send tool should light up on its channel without a
second edit.

`send_outbound_message` (category `"conversation-trigger"`) is intentionally NOT
included on the inbound path — it remains trigger-only.

### Fix 2 — resolve the outbound target without a trigger context

In `send-whatsapp-template.tool.ts`, generalize target resolution:

- If a webhook trigger context is present → use `outboundChannel` +
  `outboundTarget` (existing behaviour, unchanged).
- Else → fall back to the trusted channel identity `ctx.state.channel`
  (`{ type, id }`, server-seeded each turn — injection-resistant, never an
  LLM-supplied argument).
- If neither is available, or the resolved channel type is not `"whatsapp"`,
  return a clean error (the tool is WhatsApp-specific).

The tool then calls `channelManager.sendOutboundTemplate(ctx.instanceId, type, id, contentSid, variablesMap)`
and `getOutboundTemplateBody(ctx.instanceId, type, contentSid, variablesMap)` for
the history text — identical to the trigger path, only the target source differs.
The tool description is updated: usable in a webhook-triggered conversation **or**
a live WhatsApp chat within the open 24h window.

### Fix 3 — honor `replyHandled` in the inbound path

In `runBufferedTurn`, after the supervise/replay result is available: when
`result.replyHandled === true`,

- pass `result.replyText` as the persisted assistant content (`resultText`) to
  `runPipelinePost` instead of `replayText`, and
- return `{ text: "" }` so the WhatsApp adapter's `handleInbound` does not send a
  second message (the tool already delivered the template).

Otherwise, current behaviour is unchanged. Precedence follows the webhook-engine
precedent: a `response_generated` hook `replaceResponse` (already applied by
`runPipelinePost` via `responseGenerated`) wins over the tool `replyText`, which
wins over the LLM text.

**Unhandled edge case (out of scope).** When a `response_generated` hook replaces
the response AND the tool has already delivered a template to WhatsApp during its
execution, only the persisted/text reply is replaced — the template is already
on the wire and cannot be recalled, so delivery and history diverge. This
combination is knowingly left unhandled: response-mutating hooks and interactive
template sends are not expected to coexist on the same turn. Documented as a
known gap, not addressed in this design.

## 6. Data flow (target)

```
inbound WhatsApp msg
  → handleMessage → runPipelinePre → runBufferedTurn
      superviseArgs.includeHarness = Set(["whatsapp"])         (fix 1)
      → supervise: send_whatsapp_template equipped
          tool.execute:
            channel = triggerCtx ?? ctx.state.channel          (fix 2)
            channelManager.sendOutboundTemplate(...)  ── delivers the list ──▶ user
            replyText = getOutboundTemplateBody(...)  (body + [Button: …] lines)
            return { replyHandled: true, replyText }
      → result.replyHandled === true                           (fix 3)
          runPipelinePost(resultText = replyText)  → persists the list to history
          return { text: "" }  → adapter sends nothing more
```

## 7. Error handling

- Trigger context absent AND `ctx.state.channel` absent → tool returns an error
  object; the LLM continues with a text reply.
- Resolved channel type ≠ `"whatsapp"` → tool returns an error object.
- `sendOutboundTemplate` throws (e.g. Twilio 63016 — window closed) → the tool
  catches it and returns a clean error string; no `replyHandled`, so the LLM text
  is delivered as fallback.
- `getOutboundTemplateBody` fails (Content API unreachable) → existing fallback
  cascade (stub catalog → compact summary) still applies.

## 8. Testing

- Tool unit: resolves target from `ctx.state.channel` when no trigger context;
  still prefers trigger context when present; errors when neither is present;
  errors when the resolved channel type is not `whatsapp`.
- `runBufferedTurn` unit: when the supervise result has `replyHandled`, it
  returns `{ text: "" }` and calls `runPipelinePost` with `resultText === replyText`;
  when not, behaviour is unchanged.
- `includeHarness` derivation unit: `whatsapp` inbound equips
  `send_whatsapp_template`; `web`/`telegram`/`slack` do not.
- Integration (inbound WhatsApp turn, mocked Twilio): agent calls the tool → the
  adapter delivers exactly one template message and the persisted assistant turn
  equals the rendered template body (with options).

## 9. Caveats

- **Non-idempotent on coordinator abort.** The tool delivers during execution.
  If the message coordinator cancels the turn (a new fragment arrives) after the
  send, the template is already delivered but the turn leaves no DB trace (abort
  gate) — delivery and history diverge. Same class as `slackPostMessage`;
  documented and accepted.
- **In-session only.** This path assumes the 24h window is open. Out-of-session
  sends are unchanged (approved templates via the proactive/webhook path).
- **Harness exposure on inbound.** Fix 1 makes channel-category harness tools
  reachable on the inbound conversational path. Today that is only
  `send_whatsapp_template` on WhatsApp; documented so future harness tools are
  categorised deliberately.

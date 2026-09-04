# First-party tool notes

Behaviour of individual shipped tools — required scopes, argument shapes, what is and is
not audited. Moved out of `CLAUDE.md`: a global conventions file describing one tool's
HubSpot properties contradicts the framework-first rule it also states.

**`hubspotContact` supports custom properties:** the tool accepts a generic `customProperties: Record<string, string>` parameter for create/update (to write HubSpot custom properties like `evento`), and `filters` + `returnProperties` + `limit` + `after` for search (to query and paginate by custom property). The tool never hardcodes property names — instance-specific values (like an event name) live in the instance prompt, not in the tool code.

**`hubspotContact` search resolves owner names:** when a search result carries `hubspot_owner_id`, the tool enriches each contact with `owner_name` and `owner_email` so agents print "Mario Rossi" instead of the numeric id. The id is retained (backward-compatible). Resolution goes through the shared `resolveOwnerNames(apiKey, ownerIds)` helper in `hubspot-fetch.ts` — the reverse of `resolveOwnerIdFromEmail` — which reads `/crm/v3/owners` (paginated) into a `Map<id, {name, email}>` backed by a 1h TTL cache keyed per `apiKey:id`; repeated lookups within the TTL skip the network, and a search whose results carry no owner makes no Owners API call. Enrichment is best-effort: an Owners API failure leaves `hubspot_owner_id` intact and just omits the names. **Required token scope:** the HubSpot Private App / Service Key must include `crm.objects.owners.read`.

**`slackPostMessage` tool:** framework-first, generico (`packages/engine/src/agents/tools/slack-post-message.tool.ts`). Accetta `channel` (nome `#nome`, ID canale `C...` o ID utente `U...`) e `message`. Usa le credenziali del canale Slack configurato sull'istanza corrente via `channelManager.sendOutbound(instanceSlug, "slack", channel, message)` — lo Slack adapter risolve automaticamente gli ID utente aprendo un DM. Il canale di destinazione vive nel prompt dell'instance (no config extra). Il body del messaggio NON è loggato in audit (solo la lunghezza) per evitare leak di PII.

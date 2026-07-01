# Decoupling AI-provider AWS credentials from tool secrets

**Date:** 2026-07-01
**Status:** Approved (brainstorming)

## Problem

AWS credentials for the AI provider (Bedrock chat, Bedrock embedder, AWS/Transcribe STT)
are stored in `instance_secrets` under the generic keys `aws_access_key_id`,
`aws_secret_access_key`, `aws_region`. The `file-upload` tool (and any future S3 tool)
declares those exact same keys as `requiredSecrets`. They therefore share a single DB slot:
the AI provider credential and the tool credential are the *same row*. Setting one changes
the other; there is no way to give the provider one AWS account and a tool another.

OpenAI and Anthropic keys have dedicated names (`openai_api_key`, `anthropic_api_key`) and
do not suffer this. AWS should get the same treatment.

## Goal

Give the AI provider its own dedicated, tool-independent AWS credential namespace — including
region — resolved exactly like today (explicit secret → deploy env → default). The generic
`aws_*` keys are freed for the tools (the per-tool AWS rename is a *separate, later* effort by
the maintainer — out of scope here). Also rework the Settings-tab key-entry UX.

## Decisions

- **New keys:** `aws_provider_access_key_id`, `aws_provider_secret_access_key`,
  `aws_provider_region`. One AWS credential set shared by all AWS-backed AI services
  (Bedrock chat, Bedrock embedder, AWS/Transcribe STT). Generic (not `bedrock_*`) because it
  also covers Transcribe. The bearer token `bedrock_api_key` is unchanged.
- **The generic `aws_access_key_id` / `aws_secret_access_key` / `aws_region` leave the
  AI-provider path entirely** and become tool-only territory.
- **No data migration.** Existing live instances re-enter their AWS provider credentials by
  hand in the UI. (Rejected copy/move migration to keep the change small.)
- **Resolution order unchanged**, only the source keys change:
  1. explicit per-instance `aws_provider_*` secret
  2. deploy env — `process.env.AWS_REGION` for region; AWS SDK default provider chain
     (ECS/EC2/SSO) for credentials when not set explicitly
  3. default region `us-east-1`

## Backend changes

| File | Change |
|------|--------|
| `instances/secrets.store.ts` | In `SECRET_KEYS`: replace `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` with `AWS_PROVIDER_ACCESS_KEY_ID`/`AWS_PROVIDER_SECRET_ACCESS_KEY`/`AWS_PROVIDER_REGION` (net count unchanged = 13). |
| `instances/config-resolver.ts` | `apiKeys.bedrock_access_key_id/secret/region` and the `sttCredentials.aws` block read from the new `AWS_PROVIDER_*` keys. |
| `embeddings-gateway/provider-resolver.ts` | Bedrock branch reads new keys; region error message updated. |
| `server/memories/memory-status.ts` | Region-configured check reads `AWS_PROVIDER_REGION`. |
| `ai-gateway/providers/bedrock.ts` | No change (already reads `apiKeys.bedrock_*`). |
| `agents/tools/file-upload.tool.ts` | No change (keeps literal `aws_*` — now genuinely tool-only). |

## Frontend changes (`settings-tab.tsx`)

Restructure into separate cards (per approved UX):

1. **Modello AI** — chat provider, model, thinking/temperature toggles (existing).
2. **Embedder** — embedder provider select + existing destructive-switch warning.
3. **Credenziali provider AI** — fields for the *union* of providers actually in use
   (chat ∪ embedder ∪ STT): OpenAI key if OpenAI is used anywhere; Anthropic key if used;
   one AWS block (access / secret / region + optional Bedrock bearer token) if any AWS
   service is used. Explanatory copy: *"credenziali dei provider modello — indipendenti dai
   secret dei tool"*. This removes the "AWS asked twice" problem (chat+embedder both Bedrock).
4. **Secret dei tool** — dynamic, from `/tools/required-secrets` (unchanged).

Update the `SECRET_KEYS` mirror in the component and the i18n labels.

## Tests

Update mocks/assertions that hardcode the old key names:
`secrets.store.test.ts`, `config-resolver.test.ts`,
`embeddings-gateway/provider-resolver.test.ts`, `memory-status.test.ts`,
`settings-tab.test.tsx`. `file-upload.tool.test.ts` stays (tool keys unchanged).

## Out of scope

- Per-tool AWS credential rename (maintainer will do separately).
- Data migration of existing secrets.
- `.env`/`config.ts` changes — the region env fallback stays `AWS_REGION`.

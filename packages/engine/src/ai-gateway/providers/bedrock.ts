// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { createProvider } from "./base.js";

export const BedrockProvider = createProvider("bedrock", (modelId, apiKeys) => {
  const apiKey = apiKeys?.bedrock_api_key;
  const accessKeyId = apiKeys?.bedrock_access_key_id;
  const secretAccessKey = apiKeys?.bedrock_secret_access_key;
  const region = apiKeys?.bedrock_region ?? process.env.AWS_REGION ?? "us-east-1";

  // Per-instance Bedrock API key (bearer token) is the primary auth path and
  // takes precedence over SigV4 — it bypasses AWS credential signing entirely.
  if (apiKey) {
    return createAmazonBedrock({ apiKey, region })(modelId);
  }

  // Explicit per-instance SigV4 credentials. Otherwise delegate to the AWS SDK
  // default provider chain so ECS task roles, EC2 instance metadata, SSO, shared
  // credentials, and the AWS_BEARER_TOKEN_BEDROCK env var all work —
  // @ai-sdk/amazon-bedrock only reads env vars by default.
  if (accessKeyId && secretAccessKey) {
    return createAmazonBedrock({ accessKeyId, secretAccessKey, region })(modelId);
  }

  return createAmazonBedrock({
    region,
    credentialProvider: fromNodeProviderChain(),
  })(modelId);
});

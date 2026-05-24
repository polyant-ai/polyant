// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { createProvider } from "./base.js";

export const BedrockProvider = createProvider("bedrock", (modelId, apiKeys) => {
  const accessKeyId = apiKeys?.bedrock_access_key_id;
  const secretAccessKey = apiKeys?.bedrock_secret_access_key;
  const region = apiKeys?.bedrock_region ?? process.env.AWS_REGION ?? "us-east-1";

  // Explicit per-instance credentials take precedence. Otherwise delegate to the AWS
  // SDK default provider chain so ECS task roles, EC2 instance metadata, SSO, and
  // shared credentials all work — @ai-sdk/amazon-bedrock only reads env vars by default.
  if (accessKeyId && secretAccessKey) {
    return createAmazonBedrock({ accessKeyId, secretAccessKey, region })(modelId);
  }

  return createAmazonBedrock({
    region,
    credentialProvider: fromNodeProviderChain(),
  })(modelId);
});

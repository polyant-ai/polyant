#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { MainStack } from "../lib/stacks/main-stack.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load config
const configPath = resolve(__dirname, "../config.yaml");
const configFile = yaml.load(readFileSync(configPath, "utf8")) as Record<string, unknown>;

const stage = process.env.CDK_STAGE ?? "dev";
const stageConfig = configFile[stage] as {
  account: string;
  region: string;
  vpc: { cidr: string };
  dns?: { domainName: string; certificateArn: string };
  auth?: {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userInfoEndpoint: string;
    clientId: string;
    clientSecretArn: string;
  };
  database: { minAcu: number; maxAcu: number; deletionProtection: boolean };
  ecs: {
    cpu: number;
    memory: number;
    desiredCount: number;
    stopTimeout: number;
    engine: { cpu: number; memory: number };
    web: { cpu: number; memory: number };
  };
  logging: { retentionDays: number };
  app: { defaultInstanceId: string; timezone: string; locale: string };
  tags: Record<string, string>;
};

if (!stageConfig) {
  throw new Error(`No config found for stage "${stage}" in config.yaml`);
}
if (!stageConfig.account) {
  throw new Error(`"account" is required in config.yaml for stage "${stage}"`);
}

// HTTPS on AWS ALB requires a domain + ACM certificate — AWS does not provide
// a default TLS cert on the raw ALB DNS. The ALB-OIDC auth flow also requires
// HTTPS for the OIDC redirect_uri. Fail fast at synth if config is inconsistent.
if (stageConfig.auth && !stageConfig.dns) {
  throw new Error(
    `Stage "${stage}": "auth" requires "dns" (ALB-OIDC needs HTTPS, and ALB has no default TLS cert). ` +
      `Provide both "dns.domainName" and "dns.certificateArn" in config.yaml, or remove the "auth" block.`,
  );
}

const app = new App();

new MainStack(app, `polyant-${stage}`, {
  env: { account: stageConfig.account, region: stageConfig.region },
  stage,
  config: stageConfig,
});

app.synth();

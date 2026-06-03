import { Stack, StackProps, Tags } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";
import { VpcConstruct } from "../constructs/vpc-construct.js";
import { DatabaseConstruct } from "../constructs/database-construct.js";
import { ComputeConstruct } from "../constructs/compute-construct.js";

export interface MainStackProps extends StackProps {
  stage: string;
  config: {
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
}

export class MainStack extends Stack {
  constructor(scope: Construct, id: string, props: MainStackProps) {
    super(scope, id, props);

    // Apply tags
    for (const [key, value] of Object.entries(props.config.tags)) {
      Tags.of(this).add(key, value);
    }

    // VPC + Security Groups
    const network = new VpcConstruct(this, "Network", {
      stage: props.stage,
      cidr: props.config.vpc.cidr,
    });

    // TLS certificate (created externally, referenced by ARN)
    const certificate = props.config.dns?.certificateArn
      ? acm.Certificate.fromCertificateArn(this, "Certificate", props.config.dns.certificateArn)
      : undefined;

    // Aurora Serverless v2
    const database = new DatabaseConstruct(this, "Database", {
      stage: props.stage,
      vpc: network.vpc,
      securityGroup: network.dbSg,
      minAcu: props.config.database.minAcu,
      maxAcu: props.config.database.maxAcu,
      deletionProtection: props.config.database.deletionProtection,
    });

    // ECS Fargate + ALB
    new ComputeConstruct(this, "Compute", {
      stage: props.stage,
      vpc: network.vpc,
      albSg: network.albSg,
      ecsSg: network.ecsSg,
      dbCluster: database.cluster,
      dbSecret: database.dbSecret,
      appSecret: database.appSecret,
      ecsConfig: props.config.ecs,
      appConfig: props.config.app,
      loggingRetentionDays: props.config.logging.retentionDays,
      certificate,
      domainName: props.config.dns?.domainName,
      auth: props.config.auth,
    });
  }
}

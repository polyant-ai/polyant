import { Construct } from "constructs";
import { RemovalPolicy, Duration } from "aws-cdk-lib";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

export interface DatabaseConstructProps {
  stage: string;
  vpc: ec2.IVpc;
  securityGroup: ec2.ISecurityGroup;
  minAcu: number;
  maxAcu: number;
  deletionProtection: boolean;
}

export class DatabaseConstruct extends Construct {
  public readonly cluster: rds.DatabaseCluster;
  public readonly dbSecret: rds.DatabaseSecret;
  public readonly appSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DatabaseConstructProps) {
    super(scope, id);

    // DB credentials secret
    this.dbSecret = new rds.DatabaseSecret(this, "DbSecret", {
      secretName: `agent-builder-db-secrets-${props.stage}`,
      username: "agentbuilder",
    });

    // Aurora Serverless v2 cluster
    this.cluster = new rds.DatabaseCluster(this, "Cluster", {
      clusterIdentifier: `agent-builder-db-${props.stage}`,
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      credentials: rds.Credentials.fromSecret(this.dbSecret),
      defaultDatabaseName: "agent_crm",
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [props.securityGroup],
      serverlessV2MinCapacity: props.minAcu,
      serverlessV2MaxCapacity: props.maxAcu,
      writer: rds.ClusterInstance.serverlessV2("writer", {
        publiclyAccessible: true,
      }),
      storageEncrypted: true,
      backup: { retention: Duration.days(7) },
      deletionProtection: props.deletionProtection,
      removalPolicy: props.deletionProtection ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      parameterGroup: new rds.ParameterGroup(this, "Params", {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_16_4,
        }),
        parameters: {
          "rds.force_ssl": "1",
        },
      }),
    });

    // App secret (encryption key — placeholder, populated manually after deploy)
    this.appSecret = new secretsmanager.Secret(this, "AppSecret", {
      secretName: `agent-builder-secrets-${props.stage}`,
      description: "Agent Builder application secrets (encryption_key)",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ encryption_key: "REPLACE_ME_WITH_64_HEX_CHARS" }),
        generateStringKey: "_placeholder",
      },
    });
  }
}

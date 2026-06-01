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
      secretName: `polyant-db-secrets-${props.stage}`,
      username: "polyant",
    });

    // Aurora Serverless v2 cluster
    this.cluster = new rds.DatabaseCluster(this, "Cluster", {
      clusterIdentifier: `polyant-db-${props.stage}`,
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      credentials: rds.Credentials.fromSecret(this.dbSecret),
      defaultDatabaseName: "polyant",
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

    // App secret. `auth_secret` is auto-generated (Secrets Manager can only
    // randomise one key per secret). `encryption_key` (64 hex chars for
    // AES-256-GCM) and `auth_internal_secret` (only needed for local
    // email/password accounts) are placeholders to populate after deploy.
    // GOOGLE_* are intentionally NOT here: the engine never reads them —
    // Google OAuth is a web-only concern.
    this.appSecret = new secretsmanager.Secret(this, "AppSecret", {
      secretName: `polyant-secrets-${props.stage}`,
      description: "Polyant application secrets (auth_secret, encryption_key, auth_internal_secret)",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          encryption_key: "REPLACE_ME_WITH_64_HEX_CHARS",
          auth_internal_secret: "REPLACE_ME_OPTIONAL_FOR_LOCAL_ACCOUNTS",
        }),
        generateStringKey: "auth_secret",
        passwordLength: 48,
        excludePunctuation: true,
      },
    });
  }
}

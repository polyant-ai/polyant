import { Construct } from "constructs";
import { Duration, CfnOutput, SecretValue } from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

export interface ComputeConstructProps {
  stage: string;
  vpc: ec2.IVpc;
  albSg: ec2.ISecurityGroup;
  ecsSg: ec2.ISecurityGroup;
  dbCluster: rds.DatabaseCluster;
  dbSecret: rds.DatabaseSecret;
  appSecret: secretsmanager.ISecret;
  ecsConfig: {
    cpu: number;
    memory: number;
    desiredCount: number;
    stopTimeout: number;
    engine: { cpu: number; memory: number };
    web: { cpu: number; memory: number };
  };
  appConfig: {
    defaultInstanceId: string;
    timezone: string;
    locale: string;
  };
  loggingRetentionDays: number;
  certificate?: acm.ICertificate;
  domainName?: string;
  auth?: {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userInfoEndpoint: string;
    clientId: string;
    clientSecretArn: string;
  };
}

export class ComputeConstruct extends Construct {
  public readonly albDnsName: string;

  constructor(scope: Construct, id: string, props: ComputeConstructProps) {
    super(scope, id);

    // ── ECS Cluster ───────────────────────────────────────────
    const cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: `polyant-cluster-${props.stage}`,
      vpc: props.vpc,
    });

    // ── IAM Task Role ─────────────────────────────────────────
    const taskRole = new iam.Role(this, "TaskRole", {
      roleName: `polyant-task-role-${props.stage}`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    // Bedrock access (all regions — model availability varies)
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: ["arn:aws:bedrock:*::foundation-model/*"],
      }),
    );

    // Secrets Manager read for app secret
    props.appSecret.grantRead(taskRole);

    // CloudWatch Logs
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: ["*"],
      }),
    );

    // ── Task Definition ───────────────────────────────────────
    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      family: `polyant-task-${props.stage}`,
      cpu: props.ecsConfig.cpu,
      memoryLimitMiB: props.ecsConfig.memory,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // ── Engine Container ──────────────────────────────────────
    const engineLogGroup = new logs.LogGroup(this, "EngineLogGroup", {
      logGroupName: `/ecs/polyant-engine-${props.stage}`,
      retention: props.loggingRetentionDays,
    });

    const engineContainer = taskDef.addContainer("engine", {
      containerName: "engine",
      image: ecs.ContainerImage.fromAsset(REPO_ROOT, {
        file: "Dockerfile.engine",
        platform: ecr_assets.Platform.LINUX_AMD64,
      }),
      cpu: props.ecsConfig.engine.cpu,
      memoryLimitMiB: props.ecsConfig.engine.memory,
      essential: true,
      stopTimeout: Duration.seconds(props.ecsConfig.stopTimeout),
      environment: {
        API_PORT: "4000",
        POSTGRES_SSL: "true",
        DEFAULT_INSTANCE_ID: props.appConfig.defaultInstanceId,
        DATETIME_TIMEZONE: props.appConfig.timezone,
        DATETIME_LOCALE: props.appConfig.locale,
        // When ALB OIDC auth is configured, engine trusts x-amzn-oidc-data
        // headers instead of requiring its own Auth.js session.
        ...(props.auth ? { AUTH_MODE: "alb-oidc" } : {}),
      },
      secrets: {
        POSTGRES_HOST: ecs.Secret.fromSecretsManager(props.dbSecret, "host"),
        POSTGRES_PORT: ecs.Secret.fromSecretsManager(props.dbSecret, "port"),
        POSTGRES_DB: ecs.Secret.fromSecretsManager(props.dbSecret, "dbname"),
        POSTGRES_USER: ecs.Secret.fromSecretsManager(props.dbSecret, "username"),
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(props.dbSecret, "password"),
        ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(props.appSecret, "encryption_key"),
        AUTH_SECRET: ecs.Secret.fromSecretsManager(props.appSecret, "auth_secret"),
        // Only needed for local email/password accounts (web → engine credentials
        // verify). Harmless placeholder otherwise. GOOGLE_* are NOT injected here:
        // the engine never reads them — Google OAuth is handled entirely by the web.
        AUTH_INTERNAL_SECRET: ecs.Secret.fromSecretsManager(props.appSecret, "auth_internal_secret"),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: engineLogGroup,
        streamPrefix: "engine",
      }),
      healthCheck: {
        command: ["CMD-SHELL", "wget -q --spider http://localhost:4000/health || exit 1"],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(60),
      },
      portMappings: [{ containerPort: 4000 }],
    });

    // ── Web Container ─────────────────────────────────────────
    const webLogGroup = new logs.LogGroup(this, "WebLogGroup", {
      logGroupName: `/ecs/polyant-web-${props.stage}`,
      retention: props.loggingRetentionDays,
    });

    taskDef.addContainer("web", {
      containerName: "web",
      image: ecs.ContainerImage.fromAsset(REPO_ROOT, {
        file: "Dockerfile.web",
        platform: ecr_assets.Platform.LINUX_AMD64,
      }),
      cpu: props.ecsConfig.web.cpu,
      memoryLimitMiB: props.ecsConfig.web.memory,
      essential: true,
      environment: {
        INTERNAL_ENGINE_URL: "http://localhost:4000",
        HOSTNAME: "0.0.0.0",
        ...(props.domainName ? { NEXTAUTH_URL: `https://${props.domainName}` } : {}),
        // Gateway-authenticated mode: ALB OIDC authenticates upstream;
        // web middleware sees no Auth.js cookie and silently returns null
        // (no decrypt → no MissingSecret throw), so AUTH_SECRET is not needed.
        // AUTH_TRUST_HOST tells Auth.js to trust X-Forwarded-Host behind the ALB.
        ...(props.auth
          ? { AUTH_MODE: "alb-oidc", AUTH_TRUST_HOST: "true" }
          : {}),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: webLogGroup,
        streamPrefix: "web",
      }),
      healthCheck: {
        command: ["CMD-SHELL", "wget -q -S -O /dev/null http://localhost:3000/ 2>&1 | head -1 | grep -q 'HTTP/'"],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
      portMappings: [{ containerPort: 3000 }],
    });

    // ── ALB ───────────────────────────────────────────────────
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      loadBalancerName: `polyant-alb-${props.stage}`,
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSg,
    });

    // Reuse the existing logical ID "HttpListener" for port 80 — now redirects to HTTPS
    alb.addListener("HttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
        permanent: true,
      }),
    });

    // HTTPS listener (new)
    const listener = alb.addListener("HttpsListener", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: props.certificate ? [props.certificate] : [],
    });

    // ── ECS Service ───────────────────────────────────────────
    const service = new ecs.FargateService(this, "Service", {
      serviceName: `polyant-service-${props.stage}`,
      cluster,
      taskDefinition: taskDef,
      desiredCount: props.ecsConfig.desiredCount,
      assignPublicIp: true,
      securityGroups: [props.ecsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      enableExecuteCommand: true,
    });

    // Engine target group (API routes)
    const engineTg = new elbv2.ApplicationTargetGroup(this, "EngineTg", {
      targetGroupName: `polyant-engine-tg-${props.stage}`,
      vpc: props.vpc,
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        service.loadBalancerTarget({
          containerName: "engine",
          containerPort: 4000,
        }),
      ],
      healthCheck: {
        path: "/health",
        interval: Duration.seconds(30),
        healthyThresholdCount: 2,
      },
    });

    // Web target group (default)
    const webTg = new elbv2.ApplicationTargetGroup(this, "WebTg", {
      targetGroupName: `polyant-web-tg-${props.stage}`,
      vpc: props.vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        service.loadBalancerTarget({
          containerName: "web",
          containerPort: 3000,
        }),
      ],
      healthCheck: {
        path: "/",
        interval: Duration.seconds(30),
        healthyThresholdCount: 2,
        healthyHttpCodes: "200,302",
      },
    });

    // Build action wrapper — with or without OIDC authentication
    const wrapAction = (forward: elbv2.ListenerAction): elbv2.ListenerAction => {
      if (!props.auth) return forward;
      return elbv2.ListenerAction.authenticateOidc({
        issuer: props.auth.issuer,
        authorizationEndpoint: props.auth.authorizationEndpoint,
        tokenEndpoint: props.auth.tokenEndpoint,
        userInfoEndpoint: props.auth.userInfoEndpoint,
        clientId: props.auth.clientId,
        clientSecret: SecretValue.secretsManager(props.auth.clientSecretArn),
        scope: "openid email profile",
        sessionTimeout: Duration.hours(8),
        next: forward,
      });
    };

    // Next.js auth routes must go to web, not engine (higher priority than /api/*)
    listener.addAction("AuthRouting", {
      conditions: [
        elbv2.ListenerCondition.pathPatterns(["/api/auth/*"]),
      ],
      priority: 5,
      action: wrapAction(elbv2.ListenerAction.forward([webTg])),
    });

    // OpenAI-compatible completions endpoint stays PUBLIC even when OIDC is on:
    // it authenticates programmatic clients via per-instance API keys (the engine
    // marks POST /v1/chat/completions as @Public). Not wrapped in OIDC, and at a
    // higher priority than the catch-all engine routing below. Note: /v1/models
    // and the rest of /v1 remain behind the IdP.
    listener.addAction("CompletionsPublic", {
      conditions: [
        elbv2.ListenerCondition.pathPatterns(["/v1/chat/completions"]),
      ],
      priority: 8,
      action: elbv2.ListenerAction.forward([engineTg]),
    });

    // Route API paths to engine, everything else to web
    listener.addAction("EngineRouting", {
      conditions: [
        elbv2.ListenerCondition.pathPatterns(["/api/*", "/v1/*", "/memories/*", "/health"]),
      ],
      priority: 10,
      action: wrapAction(elbv2.ListenerAction.forward([engineTg])),
    });

    listener.addAction("WebDefault", {
      action: wrapAction(elbv2.ListenerAction.forward([webTg])),
    });

    this.albDnsName = alb.loadBalancerDnsName;

    const appUrl = props.domainName ? `https://${props.domainName}` : `http://${alb.loadBalancerDnsName}`;
    new CfnOutput(this, "AppUrl", {
      value: appUrl,
      description: "Application URL",
    });
  }
}

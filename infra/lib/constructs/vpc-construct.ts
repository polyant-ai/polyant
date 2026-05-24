import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";

export interface VpcConstructProps {
  stage: string;
  cidr: string;
}

export class VpcConstruct extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly albSg: ec2.SecurityGroup;
  public readonly ecsSg: ec2.SecurityGroup;
  public readonly dbSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: VpcConstructProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: `agent-builder-vpc-${props.stage}`,
      ipAddresses: ec2.IpAddresses.cidr(props.cidr),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // ALB Security Group
    this.albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc: this.vpc,
      securityGroupName: `agent-builder-alb-sg-${props.stage}`,
      description: "ALB security group",
      allowAllOutbound: true,
    });
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP redirect");
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    // ECS Security Group
    this.ecsSg = new ec2.SecurityGroup(this, "EcsSg", {
      vpc: this.vpc,
      securityGroupName: `agent-builder-ecs-sg-${props.stage}`,
      description: "ECS tasks security group",
      allowAllOutbound: true,
    });
    this.ecsSg.addIngressRule(this.albSg, ec2.Port.tcp(3000), "ALB to web");
    this.ecsSg.addIngressRule(this.albSg, ec2.Port.tcp(4000), "ALB to engine");

    // DB Security Group
    this.dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc: this.vpc,
      securityGroupName: `agent-builder-db-sg-${props.stage}`,
      description: "Aurora security group",
      allowAllOutbound: false,
    });
    this.dbSg.addIngressRule(this.ecsSg, ec2.Port.tcp(5432), "ECS to Aurora");

    // VPC Interface Endpoints for ECR — ensures Docker image pulls
    // (including GuardDuty Runtime Monitoring sidecar) go through
    // PrivateLink instead of public internet, avoiding intermittent 403s.
    this.vpc.addInterfaceEndpoint("EcrApiEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      securityGroups: [this.ecsSg],
    });
    this.vpc.addInterfaceEndpoint("EcrDkrEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      securityGroups: [this.ecsSg],
    });
  }
}

import { Construct } from "constructs";
import { CfnOutput } from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

export interface DnsConstructProps {
  stage: string;
  domainName: string;
  hostedZoneId: string;
  hostedZoneName: string;
}

export class DnsConstruct extends Construct {
  public readonly hostedZone: route53.IHostedZone;
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: DnsConstructProps) {
    super(scope, id);

    // Reference existing hosted zone by ID (works cross-account)
    this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });

    // ACM certificate with DNS validation against the hosted zone
    this.certificate = new acm.Certificate(this, "Certificate", {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(this.hostedZone),
    });

    new CfnOutput(this, "DomainName", {
      value: props.domainName,
      description: "Application domain name",
    });
  }
}

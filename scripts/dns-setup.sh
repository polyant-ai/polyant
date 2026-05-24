#!/bin/bash
set -euo pipefail

# Creates DNS records in a parent hosted zone for ACM cert validation and ALB alias.
# Requires credentials for the account that owns the hosted zone.
#
# Usage:
#   source awsume <parent-zone-account-profile>
#   ./scripts/dns-setup.sh <domain-name> <hosted-zone-id> <alb-dns-name> <alb-hosted-zone-id>
#
# Example:
#   source awsume exelab-prod
#   ./scripts/dns-setup.sh ab-test3.apps.exelab.net Z06031513MEHLUU2Y6N7Z agent-builder-alb-dev-123.eu-south-1.elb.amazonaws.com Z3ULH7SSC9OV64

DOMAIN_NAME="${1:?Usage: $0 <domain-name> <hosted-zone-id> <alb-dns-name> <alb-hosted-zone-id>}"
HOSTED_ZONE_ID="${2:?Missing hosted-zone-id}"
ALB_DNS_NAME="${3:?Missing alb-dns-name}"
ALB_HOSTED_ZONE_ID="${4:?Missing alb-hosted-zone-id}"

echo "Creating A record: ${DOMAIN_NAME} → ${ALB_DNS_NAME}"

aws route53 change-resource-record-sets \
  --hosted-zone-id "$HOSTED_ZONE_ID" \
  --change-batch "{
    \"Changes\": [{
      \"Action\": \"UPSERT\",
      \"ResourceRecordSet\": {
        \"Name\": \"${DOMAIN_NAME}\",
        \"Type\": \"A\",
        \"AliasTarget\": {
          \"DNSName\": \"${ALB_DNS_NAME}\",
          \"HostedZoneId\": \"${ALB_HOSTED_ZONE_ID}\",
          \"EvaluateTargetHealth\": true
        }
      }
    }]
  }" --query 'ChangeInfo.Status' --output text

echo "Done. ${DOMAIN_NAME} → ${ALB_DNS_NAME}"

import { CfnOutput, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';
import type { Construct } from 'constructs';

export interface MailStackProps extends StackProps {
  /** Route 53 hosted zone of the sending domain (the company domain). */
  hostedZoneId: string;
  hostedZoneName: string;
}

/**
 * SES domain identity used by Cognito to send invitations and password-reset codes (instead of
 * Cognito's default sender, limited to ~50 e-mails/day from no-reply@verificationemail.com).
 *
 * Deployed BEFORE the application stack: Cognito refuses an unverified identity, and DKIM
 * verification is asynchronous (usually minutes). DNS records are added to the hosted zone:
 * 3 DKIM CNAMEs and a custom MAIL FROM subdomain (MX + SPF) — additive, they do not touch the
 * domain's existing mail (MX of the apex) setup. A new SES account starts in the sandbox (can only
 * send to verified addresses/domains): request production access before onboarding employees.
 */
export class MailStack extends Stack {
  constructor(scope: Construct, id: string, props: MailStackProps) {
    super(scope, id, props);
    Tags.of(this).add('app', 'dailytasks');
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName: props.hostedZoneName });
    const identity = new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.publicHostedZone(zone),
      mailFromDomain: `ses-bounce.${props.hostedZoneName}`,
      dkimSigning: true,
    });
    identity.applyRemovalPolicy(RemovalPolicy.RETAIN);
    new CfnOutput(this, 'SesIdentity', { value: identity.emailIdentityName });
  }
}

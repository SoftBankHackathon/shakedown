# MongoDB TLS and automatic failover — 2026-10-10

> Follow-up: [database live validation](2026-10-10-database-live-validation.md)
> subsequently verified fresh-stack bootstrap and manual Mongo EBS recovery.
> The untested-backup statements below describe this earlier failover run;
> automated backup scheduling remains blocked.

## Scope and result

A dedicated AWS experiment deployed three EC2 MongoDB 8.0 members across three
Seoul AZs, separate encrypted EBS volumes, and two ECS application tasks using
the `medium` architecture. The application used the official MongoDB Node driver,
a version-pinned Secrets Manager replica-set URI, and a CA copied into a read-only
task volume by an ECS init container. DB ingress was limited to app/member security
groups; the experiment ALB was restricted to the experiment client's address.

The ECS app connected over verified TLS, returned HTTP 200 and performed majority
writes/read-after-write checks. The application never received cluster/admin
credentials or server private keys.

| Test | Observed result |
| --- | --- |
| Valid CA + TLS from another member | connection/ping exit 0 |
| TLS without the private CA | rejected: self-signed certificate in certificate chain |
| Plaintext connection | no successful connection within 12 seconds; client timed out |
| EC2 primary stop | new primary and successful write observed after 2.13 seconds; no failed probes in the two coarse samples |
| Primary process SIGKILL, restart temporarily disabled | new primary/write observed after 12.24 seconds; two HTTP failures |
| Restart/join stopped member | all three members healthy again |
| Previously acknowledged documents | both selected pre-fault documents retained |

Times start at the experiment's fault request, include control-plane/SSM latency,
and measure the first successful write response identifying the new primary. They
are not precise election times or a downtime SLA. The process-kill experiment
explicitly observed temporary unavailability. Two-member loss, prolonged network
partitions, large data sets and backup restore were not tested.

A hostname-mismatch negative attempt did not connect within 12 seconds, but its
specific failure cause was not isolated; it is not claimed as a conclusive
hostname-verification test. No `tlsAllowInvalidCertificates`,
`tlsAllowInvalidHostnames` or `tlsInsecure` option was used. Positive connections
use normal driver verification of the member certificate/IP SAN.

## Defects and account restrictions found

- The initial replica initiation could run before the third Mongo process became
  reachable. Added retries around `rs.initiate`; reran the corrected initialization
  suffix through SSM on the same node, after which all members and app credentials
  became ready. The updated bootstrap is embedded in the final template. The
  entire stack was not recreated after this retry fix.
- AWS Backup vault creation was denied for insufficient backup-storage/KMS
  privileges. An EBS-specific DLM policy was also explicitly denied by the account's
  organization SCP. No principal permissions were expanded or policy bypassed.
  The live TLS/failover stack used `EnableMongoSnapshots=false`. Scheduled backups
  remain inactive/unverified in this account; backup restore was not tested.
- The Python installation's HTTPS CA store could not validate the client-IP lookup
  endpoint. Used system curl with normal certificate verification instead; no TLS
  verification was disabled.

## Reproduction

1. Use a new dedicated MongoDB stack and follow [managed DB setup](../managed-databases.md).
2. Build `examples/http-mongodb` for Linux AMD64, publish a single manifest to its
   ECR repository, and use the immutable digest. The example is an experiment
   probe, not a production API.
3. Run `experiment-mongo-deploy.ts config.json image@sha256:... ready.json` from
   the AWS adapter scripts with the dedicated AWS profile/config. It deploys two
   ECS tasks and verifies readiness through the actual adapter.
4. Run `experiment-mongo-failover.py config.json result.json` with
   `HACKATHON_MONGO_FAILOVER=1`. Default fault is `ec2-stop`; set
   `HACKATHON_MONGO_FAULT=process-kill` for a SIGKILL. These commands deliberately
   interrupt the primary and restore it afterward; use experiment stacks only.
5. Verify documents and replica health, stop the ECS service, stop Mongo EC2
   instances, delete the experiment stacks, and remove experiment-owned retained
   Secrets/ECR/logs and generated EBS snapshots. Stopping ECS alone leaves DB and
   infrastructure charges running.

[Machine-readable evidence](evidence/2026-10-10-mongodb-tls-failover.json) records
TLS checks, probe traces and replica recovery. Cleanup status is recorded there.

## Automated verification

Engine 278, local adapter 12, AWS adapter 44 tests passed; web lint/build, AWS TypeScript, CloudFormation cfn-lint and shell syntax checks passed. The template embeds exactly the three rendered bootstrap scripts checked against their reviewed source.

## Cleanup completed

The live stack and both failed-attempt stacks reached DELETE_COMPLETE. All three Mongo EC2 instances terminated. The live stack's four retained Secrets, ECR repository/image, log group and three generated EBS snapshots were deleted, and its task definition deregistered. Failed-attempt retained resources were removed as well. The local pushed image and temporary Docker authentication/profile files were removed. No scheduled backup policy was active in the experiment.

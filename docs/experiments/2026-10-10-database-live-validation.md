# Database live validation — 2026-10-10

Follow-up to merged PRs #11/#12, using dedicated Seoul experiment stacks.
The live run used merged baseline `3ffbcb0` plus this TLS patch. The branch was
then fast-forwarded to `2d4829e` (new GCP/Azure work); no AWS/runtime files
conflicted, and AWS/local automated tests were rerun. The new cloud adapters
were not live-tested by this experiment.

No team database was modified. The experiment ALBs were restricted to the
experiment client's address before the application was deployed.

## MySQL deployment and TLS

RDS MySQL 8.4.7, db.t3.micro, encrypted private storage, and a small ECS task
were provisioned through the existing foundation and actual AWS adapter.
The app used the generated, version-pinned `DATABASE_URL` secret, mysql2 3.24.5,
and the AWS RDS CA bundle. HTTP 200, TLS_AES_256_GCM_SHA384 and Unicode writes
were observed. No CA or hostname verification was disabled.

Live preparation found that mysql2 distinguishes certificate-chain verification
from hostname verification. The shared MySQL URL now explicitly enables both
`rejectUnauthorized` and `verifyIdentity`. A negative connection uses the real
network endpoint but a deliberately wrong TLS host; it is rejected. mysql2
rewrites its code to HANDSHAKE_SSL_ERROR, so the probe checks the specific
hostname-mismatch message instead of accepting any handshake error as proof.

The first probe revision misclassified that rejection because it expected the
original Node error code. This was a test-harness defect, not a successful
connection with an invalid hostname. The rebuilt immutable image passed.

## MySQL backup and restore result

RDS backup retention was one day and an encrypted automated snapshot was
observed `available`. A manual snapshot was created and restored to a separate,
private encrypted db.t3.micro instance. The copied adapter config used the new
instance ID/endpoint; deployment regenerated the URL Secret and registered a
new task definition with its immutable Secret version.

The original UUID/Unicode record was found on the restored DB over verified TLS,
and a new write succeeded. The reported DB hostname changed, confirming that
verification used the restored server rather than the original. This tests a
manual snapshot restore, not point-in-time restore or long-term retention.

## MongoDB fresh bootstrap and manual recovery

A fresh three-AZ replica set completed CloudFormation creation without rerunning
bootstrap via SSM. This closes the previous full-stack revalidation gap after
the rs.initiate retry fix. The actual adapter deployed two ECS app tasks using
verified TLS and the injected CA volume.

After a majority write, the selected secondary was checked for the document,
cleanly stopped, and its EBS data volume snapshotted. The original member was
restarted. The snapshot was restored into a new encrypted EBS volume in that AZ,
attached and mounted with XFS `nouuid`. A separate MongoDB container used
`--network none`, TLS and the matching admin credentials on that restored volume.
It read the original document and wrote/read another one. No original volume
was replaced, and the restored container could not join the active replica set.

The restore container, new volume and manual snapshot were removed. The CLI
wrapper initially failed to parse the empty successful delete-volume response;
SSM's successful verification output and EC2 absence were checked independently,
and the remaining snapshot was deleted.

## Boundaries

DLM listing is still explicitly denied by the organization's SCP. This run did
not create a schedule by another mechanism or expand permissions. Mongo scheduled
backup remains unavailable/unverified; manual recovery does not prove automation,
point-in-time recovery, complete replica-set reseeding or backup retention.

MySQL testing covers the mysql2 URL/CA path, not all language drivers/JDBC.
The apps are dedicated experiment probes, not production APIs. This is the actual
AWS adapter path, not scanner → LLM → browser end-to-end verification. No claim
of load capacity, zero downtime, certificate auto-renewal or EC2 replacement is made.

## Validation

AWS adapter 45 tests and local adapter 12 tests passed. AWS TypeScript and probe
JavaScript syntax checks passed. The probe lockfile uses mysql2 3.24.5 and npm
audit found zero vulnerabilities at experiment time.

Sources: [mysql2 connection examples](https://sidorares.github.io/node-mysql2/docs/examples/connections/create-connection),
[AWS snapshot restoration](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_RestoreFromSnapshot.html).

## Reproduce the MySQL probe

1. Provision a new dedicated MySQL stack with app port 3000/database `app`, then
   convert outputs with `config-from-outputs.ts`. Restrict the ALB ingress to the
   test client's address before deploying the probe.
2. Build `examples/http-mysql` as a single Linux AMD64 manifest with
   `--provenance=false --sbom=false`, publish to the stack ECR with a new immutable
   tag, and pass the digest to `experiment-mysql-deploy.ts config.json image@sha256:... ready.json`.
3. `/probe` inserts a unique Unicode record and returns its ID; `/tls-negative`
   must report hostname rejection. These are test endpoints, not a public app.
4. Create an RDS DB snapshot; wait for `available`. Restore to a **new** DB instance
   with the same private subnet group/security group and encrypted storage.
5. Copy the experiment adapter config and change only the DB instance ID and host
   to the restored instance. Redeploy using the same immutable image. Verify
   `/verify/<original-id>` and a new `/probe` write. This also exercises URL Secret
   regeneration and task pinning for the new endpoint.
6. Stop the ECS service through the adapter, delete the restored RDS, then delete
   the original CloudFormation stack. Remove experiment-owned retained Secrets,
   images/logs, generated/manual snapshots and task-definition registrations.
   Verify absence; ECS stop by itself is not infrastructure cleanup.

## Cleanup

Both dedicated stacks reached DELETE_COMPLETE. Original/restored RDS instances,
manual and automated RDS snapshots, retained automated backups, both ECR
repositories and all six retained Secrets were independently confirmed absent.
Cleanup also removed experiment logs, Mongo volumes/snapshots and deregistered
task definitions. Temporary AWS credentials and Docker registry authentication
were removed locally. No GCP or Azure resources were changed or tested.

[Machine-readable evidence](evidence/2026-10-10-database-live-validation.json).

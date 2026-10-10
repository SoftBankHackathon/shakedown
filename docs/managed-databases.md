# PostgreSQL, MySQL and MongoDB runtime support

Explicit HTTP runtime settings now support `none`, `postgres`, `mysql`, `mongodb`,
and `external`. Set the engine to match the application's existing driver and data
model. This does not translate SQL, install application drivers, or migrate data.
A detected conflicting engine blocks planning/build; unknown detection remains a
warning. Prepared Dockerfiles and the security gate remain required.

| Engine | Local | AWS | URL binding |
| --- | --- | --- | --- |
| PostgreSQL | `postgres:17-alpine`, private volume | existing RDS workflow | `postgres_url` |
| MySQL | `mysql:8.4`, app-scoped account, private volume | RDS MySQL 8.4 | `mysql_url` |
| MongoDB | `mongo:8.0`, app database readWrite user, private volume | three-AZ EC2 replica set + encrypted EBS | `mongodb_url` |

Example (change `mode` and URL binding together):

```json
{
  "version": "http-runtime.v1", "port": 3000, "health_path": "/",
  "env": {}, "secret_refs": {},
  "database": {"mode":"mysql","name":"app","bindings":{"DATABASE_URL":"mysql_url"}},
  "init_command": []
}
```

The UI switches the suggested DATABASE_URL binding with the engine. Apps using
other environment names can edit the mapping. Local adapters wait for DB health
before running the app's initialization argv. Production DB ports are not
published by Compose. Tests temporarily expose loopback-only ports, then remove
their containers, volumes and networks. Compose 2.23.1+ is needed for Mongo's
inline initialization config.

## URL and driver compatibility

Credentials are URI-encoded, including percent/dollar signs and Unicode. MySQL
URIs were tested with the open-source `mysql2` driver; MongoDB with the official
`mongodb` driver. URI acceptance and TLS query parameters depend on the driver's
API, not the programming language. Go's native MySQL driver, for example, may
require its DSN API rather than a URI: use host/port/name/username/password
bindings and construct its configuration in the app. MongoDB JDBC URLs are rejected.

AWS MySQL URI includes a mysql2-compatible JSON `ssl` option requiring certificate
and hostname verification (`rejectUnauthorized` and `verifyIdentity`). The app must configure trust for the RDS CA (e.g. the driver's
Amazon RDS profile or CA bundle); other drivers need their equivalent TLS
configuration. Java JDBC binding uses `sslMode=REQUIRED`. No certificate checks
are disabled to make a connection succeed. AWS MySQL TLS and hostname-mismatch rejection were live-tested with the
`examples/http-mysql` probe and the RDS CA bundle. See [mysql2 TLS documentation](https://sidorares.github.io/node-mysql2/docs/documentation/ssl).

## AWS provisioning

Use a **new dedicated stack per engine**. The helper refuses to change an existing
stack's engine and fails closed when existing-stack lookup is denied. It does
not migrate/replace the team's PostgreSQL DB. Direct manual CloudFormation
updates still require operator review of replacements.

Set the existing provisioning profile/account/stack variables, then:

- MySQL: `HACKATHON_DATABASE_ENGINE=mysql`, `HACKATHON_MYSQL_VERSION=<available 8.4 patch>`.
- MongoDB: `HACKATHON_DATABASE_ENGINE=mongodb`.
- Optional: `HACKATHON_DATABASE_NAME=app`, `HACKATHON_APP_PORT=3000`.

Run `infra/aws/scripts/provision.sh`, save its stack outputs and run the existing
`config-from-outputs.ts` converter. `dbEngine` and the new engine's address/id,
DB name and URL/password Secret ARNs populate the adapter configuration. This is
an operator provisioning command, not automatic onboarding of an empty AWS account
through the Deploy button. The MongoDB TLS replica-set stack was exercised in the linked live experiment; the MySQL RDS path was also deployed with the actual AWS adapter and verified TLS.

MySQL follows the existing RDS small/medium/large workflow including Multi-AZ
changes. RDS remains private. PostgreSQL is the default for legacy configuration.

### MongoDB EC2 lifecycle and security boundaries

The selected design is **MongoDB Community replica set on three EC2 instances across three AZs**, not DocumentDB:

- Three t3.small instances, Amazon Linux 2023 via the AWS AMI parameter; Docker `mongo:8.0`.
- DB ingress 27017 is allowed only from the application's security group; no SSH
  port. A separate self-referencing security-group rule permits member replication. Each EC2 has a public address for bootstrap/image downloads, but ECS connects
  to its private address. SSM is available through its instance role.
- IMDSv2 required, encrypted root disk, separate encrypted 20 GiB EBS data volume per member.
  EC2 replacement does not deliberately delete that data volume. EBS deletion/
  replacement uses Snapshot policies; restore/reattach is an operator action.
- The app gets readWrite only on its configured database. The random root password
  remains on the EC2, not in the app's Secret. Bootstrap files are root-private.
- Bootstrap waits for the data disk and authenticates as the app before publishing
  its URL to the dedicated Secret and signalling stack readiness. Failure times
  out stack creation instead of reporting ready. The adapter checks three EC2 addresses/AZs/VPC and at least two running members. It consumes the replica-set URL and CA through fixed Secret versions. A nonessential ECS init container writes only the public CA to a task volume; the app waits for its success and mounts the CA read-only. TLS is required on MongoDB. Applications receive all three seed addresses, replicaSet, majority writes and retryWrites settings. Server/member certificates are verified against a private CA; the application never receives server private keys or the cluster keyfile.
- The adapter does **not** regenerate Mongo credentials from a possibly rotated
  source secret. Mongo password rotation must update the DB user, protected EC2
  configuration and URL Secret together, then redeploy ECS. Merely rotating the
  source Secret does not change an existing Mongo user.
- Only `mongodb_url` is supported for AWS credentials; separate username/password
  bindings are rejected to avoid mixing credential versions.

**TLS/HA scope:** MongoDB requires TLS; certificates cover all three member IPs,
with server/client authentication EKUs. Inter-member access also requires a
shared keyfile. App connections must trust the mounted CA at
`/run/shakedown/db-ca/ca.pem`; the official Node driver was tested. Other drivers,
particularly Java/JVM TLS configuration, may need an SSLContext/trust-store setup
using that CA rather than URI `tlsCAFile` support. Never disable certificate or
hostname checks to compensate. Leaf certificates last one year; certificate/CA
renewal requires coordinated rollout of Mongo members and ECS tasks and is not
automated here. The CA signing key is discarded after signing; EC2-only Secrets
Manager storage holds the shared leaf key and replication keyfile.

The replica set tolerates one unavailable voting member. Elections can interrupt
writes; clients use majority write concern and retryable writes. Two unavailable
members lose quorum. Failed host replacement/reseeding is an operator action;
this does not automatically replace a failed EC2 instance. All app architecture tiers use this fixed three-member DB;
app scaling does not imply DB capacity autoscaling. Sharding, cross-region DR and
DB capacity/SLA guarantees remain outside scope.

### Backup and recovery

An optional AWS DLM policy schedules EBS snapshots daily at 18:00 UTC (03:00 KST)
and retains seven snapshots per member. These are crash-consistent volume
snapshots, not a coordinated replica-set backup or logical point-in-time recovery.
Restore from a chosen consistent member and reseed the remaining members; do not
combine arbitrary snapshots from different points in time.

The experiment account denied AWS Backup vault creation and explicitly denied
DLM creation through an organization SCP. No account permission was expanded.
The TLS/failover experiment used `HACKATHON_MONGO_SNAPSHOTS=false`; scheduled
backups were **not activated or verified**. The template defaults to enabled for
accounts where DLM is allowed. Check actual jobs and recovery, not just a schedule.

Recovery runbook:

1. Close application traffic and stop MongoDB writes; record the current stack,
   volume and matching credential Secret versions without copying secret values.
2. Restore a selected member EBS snapshot to a new encrypted volume in the EC2 AZ.
   Keep the old volume until recovery verification is complete.
3. Through SSM, stop the Mongo container, unmount the data filesystem, and replace
   the data attachment. Reconcile the attachment with CloudFormation to avoid
   untracked drift. Update the mount UUID in `/etc/fstab` to the restored volume.
4. Start MongoDB with matching credentials; verify authentication and known data
   before reopening traffic. Recover/republish the matching URL Secret and
   redeploy ECS if needed. Reseed/rejoin the remaining replica members and recheck snapshot selection tags on all volumes.

ECS DELETE stops the application only. EC2/EBS/snapshots/RDS and retained Secrets or
snapshots continue to incur costs until separately cleaned up. A cleanly stopped secondary EBS snapshot was restored to a separate encrypted volume,
and an isolated MongoDB process verified the original document plus a new write.
This validates manual single-member recovery, not scheduled backup or full replica-set reseeding. TLS/replica-set AWS results are recorded in [the live experiment](experiments/2026-10-10-mongodb-tls-failover.md).

## Reused upstream software

- [MySQL Docker Official Image entrypoint](https://github.com/docker-library/mysql/blob/master/8.4/docker-entrypoint.sh): database/user initialization and server startup.
- [Mongo Docker Official Image](https://github.com/docker-library/mongo): server and initialization hooks; app-scoped user creation uses Mongo's API.
- [mysql2](https://github.com/sidorares/node-mysql2) and [official MongoDB Node driver](https://github.com/mongodb/node-mongodb-native): real connection tests, not custom DB protocols.
- Existing AWS SDK, Secrets Manager, CloudFormation, EBS and DLM integrations.

MongoDB Community Server uses [SSPL](https://www.mongodb.com/legal/licensing/community-edition).
Do not describe all reused server components as permissively licensed open source;
check upstream terms for the intended distribution/service model. Dependencies
are lockfile-pinned; server images currently track their stated version tags.

## Verification

[Local driver evidence](experiments/evidence/2026-10-10-mysql-mongodb-runtime.json):
MySQL and MongoDB read/write, special-character credentials, wrong-password
rejection and data after a restart passed. Mongo app admin operations were denied.
Temporary test resources were removed. AWS SDK tests cover MySQL architecture
commands and Mongo secret-only injection/EC2 checks; template lint and bootstrap
shell syntax are checked. The follow-up also live-tested RDS MySQL small deployment,
verified TLS and hostname-mismatch rejection, RDS snapshot restoration with the
original record preserved and new writes working, and Mongo manual volume restoration. The separate [AWS TLS/failover experiment](experiments/2026-10-10-mongodb-tls-failover.md) records live AWS results; see [follow-up live validation](experiments/2026-10-10-database-live-validation.md)
for manual recovery evidence and remaining limitations.

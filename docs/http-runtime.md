# Language-independent HTTP deployment

The project page now has **HTTP 앱 실행 설정**. Save it before architecture
planning/deployment. The contract is `http-runtime.v1`; it supports one HTTP
container with a configurable port and health path. The application must bind
`0.0.0.0`, read its configured port, and return HTTP 200 from its health endpoint.
Runtime settings are explicit user inputs, not facts guessed by the LLM.

For MySQL/MongoDB setup, driver/TLS requirements and EC2 backup/recovery, see [managed databases](managed-databases.md).

## Database modes

- `none`: no local PostgreSQL service, no Spring variables, no DB secret or
  migration task, and no AWS RDS inspection/modification.
- `postgres`: local Compose creates PostgreSQL; AWS uses the dedicated RDS
  instance already configured in the adapter. Map environment variable names
  to `host`, `port`, `name`, `username`, `password`, `jdbc_url`, or `postgres_url`. The password
  is resolved by the adapter/Secrets Manager and never stored in project JSON.
- `mysql` / `mongodb`: automatically provision local official-image containers; AWS uses prepared RDS MySQL / three-AZ TLS MongoDB replica set respectively. Use matching `mysql_url` / `mongodb_url` bindings. MongoDB AWS uses a fixed three-member TLS replica set.
- `external`: pass the app's existing connection through adapter-registered
  secret references. No DB is provisioned or resized. Network reachability,
  credentials and TLS options for the external PostgreSQL endpoint are the
  operator's responsibility; external connectivity was not live-tested here.

Example Node/PostgreSQL configuration (Python can use the same libpq names or
custom names such as `APP_DB_HOST`):

```json
{
  "version": "http-runtime.v1",
  "port": 3000,
  "health_path": "/health",
  "env": {"NODE_ENV": "production"},
  "secret_refs": {},
  "database": {
    "mode": "postgres",
    "name": "app",
    "bindings": {
      "PGHOST": "host", "PGPORT": "port", "PGDATABASE": "name",
      "PGUSER": "username", "PGPASSWORD": "password"
    }
  },
  "init_command": ["node", "migrate.mjs"]
}
```

POST this object to `/api/projects/{id}/runtime`. For a DB-free app set mode to
`none`, bindings to `{}`, init_command to `[]`. Omitted runtime retains the
legacy Spring sample behavior. For unsupported import stacks use image-only
import first, then save explicit HTTP execution settings; a valid Dockerfile
or supported generation path is still required.

`PORT` and `TZ` are injected by the adapter. Duplicate/reserved names are
rejected. Put only non-secret configuration in `env`. For an external
connection use, for example, `secret_refs: {"DATABASE_URL":"app_database_url"}`.
Register `app_database_url` in the local `LOCAL_SECRETS_FILE` or the AWS adapter
config's `secrets` map. AWS values are Secrets Manager ARNs (optional JSON-key
suffixes); provision the execution role's exact secret read permissions
separately. The adapter cannot accept arbitrary secret ARNs from a browser.

Initialization is an explicit argv list executed in the same image before
service rollout. Its first argument overrides the image entrypoint. It is
never interpreted as a host shell command. An empty list skips initialization;
nonzero exit or timeout fails deployment. Commands must be safe to repeat,
backward-compatible with the previous running app, and contain no plaintext
secrets. DB changes are not rolled back when rollout fails.

## AWS foundation

For a **new** DB-free foundation set `HACKATHON_CREATE_DATABASE=false` and
`HACKATHON_APP_PORT=3000` when using `infra/aws/scripts/provision.sh`. The
CloudFormation parameters are `CreateDatabase=false` and `AppPort=3000`.
DB resources and DB secret grants/outputs are conditional. The output conversion
script accepts missing DB outputs and reads Port. ECS, ALB, ECR and their network
and IAM prerequisites still need provisioning; this is not empty-account
onboarding. Runtime port must match the prepared stack's port.

Do not switch an existing stateful stack to `CreateDatabase=false` just to test
this feature: normal CloudFormation retention/snapshot policies apply, and
retained DB/secret resources can continue to cost money. A DB-free runtime on
an existing stack does **not** delete its DB. For managed PostgreSQL use
`CreateDatabase=true`, choose an available PostgreSQL version, regenerate
adapter config, and match the runtime DB name to that configuration.

Architecture selection now supports explicit HTTP runtime settings independent
of the detected language. Runtime changes invalidate prior selections.
Small/medium/large still govern ECS compute/AZ/scaling; RDS Multi-AZ settings
apply only to managed PostgreSQL. CPU/RPS heuristics are not capacity guarantees.

## Validation and remaining gate dependency

`node infra/local/smoke-runtime.mjs` builds the Node and Python examples and
checks five combinations (each language with/without PostgreSQL, plus Node DATABASE_URL), including
repeatable initialization and HTTP results. It uses the real Compose spec
builder, exposes only a temporary loopback port, removes its own containers,
volumes, networks and image tags, and never starts a public tunnel or AWS.
It tests runtime execution independently of Security Gate, not an ALLOW-to-public
engine deployment. AWS SDK request tests cover environment/secret mapping,
DB-free deployment and migration failure; no new real AWS deployment has been
performed for this change.

Security Gate #16 remains a mandatory predecessor for engine planning/builds.
#25 adds Java/JavaScript/TypeScript rules and validated wrapper-JAR exclusion.
A missing Compose file is ALLOW, but Semgrep and Gitleaks must both succeed. Sources outside the scanned allow-list are blocked
(`UNSUPPORTED_SOURCE`); template/external-script coverage gaps are reported but do
not block. This runtime generalization never bypasses that gate. Workers, batch jobs, multiple app containers,
arbitrary persistent volumes and automatic MySQL conversion remain unsupported.


## Managed PostgreSQL connection URLs (2026-10-10)

Applications accepting a PostgreSQL URI, including Go/Rust drivers, can set:

```json
{"mode":"postgres","name":"app","bindings":{"DATABASE_URL":"postgres_url"}}
```

The application must actually read that variable and support PostgreSQL URIs;
this does not rewrite application code or install a DB driver. Standard Node
URL encoding handles credentials (including `%`, `$`, `@` and Unicode).
Local Compose creates a private DB and supplies a URL with `sslmode=disable`;
the generated private Compose file contains secrets and must not be shared.
AWS supplies `sslmode=require` via ECS Secrets Manager references, never plain
ECS environment values. Missing URL-secret configuration fails validation.

Update the foundation stack and regenerate adapter outputs/config to obtain
`dbUrlSecretArn`. This dedicated secret is distinct from `dbPasswordSecretArn`.
At deployment, the adapter reads the password secret and refreshes the URL
secret only when changed, pinning both secret version references in the task
definition. Rotation requires a new deployment; running tasks do not auto-refresh.
Coordinate rotations outside deployment/migration runs. The adapter can now read
DB credentials in memory and write only the dedicated URL secret; keep its
principal restricted. Retained URL secrets need explicit cleanup after a demo.

For external DBs use `secret_refs`, register the reference in adapter `secrets`,
and pass exact secret ARNs through foundation `AdditionalSecretArns`. For a
customer-managed KMS key also set `AdditionalSecretKmsKeyArns` and allow the role
in that key's policy. These grants do not establish DB network reachability or
convert DB engines. External DB URIs are supplied as-is, not generated.

Detected DB + `none`, or non-PostgreSQL DB + managed `postgres`, blocks both
architecture selection and direct engine build. `external` is not subject to
managed RDS compatibility checks; local persistence warnings still apply.
Unknown DB detection is not proof of a DB-free app.

Latest validation: engine 278 tests, local 12 tests, AWS SDK 44 tests; CloudFormation
lint, TypeScript, web lint/build. AWS tests use SDK doubles. The PostgreSQL URL synchronization path and external IAM grants have not been redeployed to a live AWS account. The later MongoDB TLS replica-set path was live-tested; see [results](experiments/2026-10-10-mongodb-tls-failover.md).

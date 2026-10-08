# Local deployment — 김태윤

팀원용 [담당 범위·연동 인수인계](HANDOFF.md): 완료 항목, 호출 예제, 검증 결과와 남은 통합 작업.

PostgreSQL 17 + sample app + Cloudflare Quick Tunnel. Requires Docker Compose v2,
Node.js 22+ and outbound HTTPS. Java is built inside Docker; host Java is optional.

## Run today: app + PostgreSQL

From `infra/local`:

```sh
cp .env.example .env
# Set LOCAL_DB_PASSWORD in .env to a random password.
docker compose up -d --build
curl -f http://localhost:18080/health
python3 smoke.py http://localhost:18080
```

Publish only the **demo app** (uses a temporary trycloudflare.com URL):

```sh
docker compose --profile public up -d
docker compose logs tunnel
```

Quick Tunnel URLs change when the tunnel is recreated. If local DNS cached NXDOMAIN,
the control service retries resolution via 1.1.1.1/1.0.0.1 for trycloudflare.com only,
while retaining HTTPS certificate verification. Browsers using that stale resolver may
need to wait for its cache to expire. For smoke testing only, `--resolve <IP>` overrides
DNS for the URL hostname (obtain it with `dig +short <hostname> @1.1.1.1`). Do not put real user data
in this demo. The DB has no published host port. `docker compose down` stops this
stack and retains the PostgreSQL volume.

## Engine integration

Build the shared image from the repository root:

```sh
docker build -t shakedown/kty-board:local samples/kty-board
```

From `infra/local`, start the control service:

```sh
npm start
curl -f http://127.0.0.1:9101/health
curl -sS -H 'Content-Type: application/json' --data-binary @deploy.example.json http://127.0.0.1:9101/deployments
curl -sS http://127.0.0.1:9101/deployments/dep_localdemo
curl -sS http://127.0.0.1:9101/deployments/dep_localdemo/logs
```

Implements `packages/contracts/openapi/target.yaml` v0.1.0:

- POST returns 202; poll GET every 2–3 seconds. Status: pending → deploying → ready/failed.
- `ready` requires the public Tunnel URL + `health_path` to return **200**, without following redirects.
- The engine supplies a prebuilt `image`; both targets should run the same image.
- PostgreSQL is the only supported DB here. An explicit MySQL request returns 400.
- App DB URL/user/password are set consistently with the managed PG service. Password
  comes from LOCAL_DB_PASSWORD or `secret_refs.SPRING_DATASOURCE_PASSWORD`.
- Secret names resolve through LOCAL_SECRETS_FILE (JSON object); `db_password`
  falls back to LOCAL_DB_PASSWORD. Secret values are never stored in API state or responses.
- Same deployment ID returns the existing result. A different ID for an actively
  deploying project returns 409. Subsequent deployments get isolated DB volumes.
- `replicas` and `sticky_sessions` are accepted but not implemented; actual values
  are reported as one replica and no sticky sessions in `info`.
- Logs are timestamped, redact configured secrets, and support `?since=<ISO timestamp>`.
- `DELETE /deployments/{id}` waits for active deployment, removes its containers/network,
  and preserves its DB volume. Logs/state are removed; failed cleanup remains retryable.
- State survives service restarts. In-progress deployments become failed on restart;
  inspect/remove them before retrying. Ready status records the last successful probe,
  not continuous monitoring.

The API is **loopback-only** and rejects browser Origin requests. Run the engine on
this machine, or use an SSH port forward. Never point Cloudflare Tunnel at port 9101:
it is an unauthenticated Docker control API. The public URL belongs to the app only.
`.data` contains private Compose configuration (including credentials), permission 0600,
and is ignored by Git. Run one control service per data directory.

## Validation

```sh
npm test
python3 smoke.py https://YOUR.trycloudflare.com --marker smoke-demo1
# After an app restart, verify data remains:
python3 smoke.py https://YOUR.trycloudflare.com --marker smoke-demo1 --verify-only
```

## One-command rehearsal

```sh
npm run demo
```

Builds the current sample, creates an isolated PostgreSQL DB, and verifies the whole
sequence: normal data persists → demo-reset loses data on restart → normal mode
keeps new data again. Docker assigns an unused loopback port. Every run uses a new
Compose project; finally it removes only that run's containers/network/volume, even
if a check fails. A JSON report is retained in `.data/rehearsal-*/report.json`.
The existing deployment, Tunnel and DB are unaffected. No .env or manual password
is required for this rehearsal; it generates private disposable credentials.

## Data-loss demo (disposable data only)

The demo failure is: `demo-reset` uses Hibernate `ddl-auto=create`, so an
app restart drops/recreates tables **in PostgreSQL**. Normal mode uses `update`.
This is an explicit demo configuration; it does not randomly discard writes.
AWS/AI testing integration should use this same restart trigger and profile switch.

Use a separate Compose project/volume so normal demo data is unaffected:

```sh
BOARD_PROFILE=demo-reset BOARD_PORT=18081 docker compose -p shakedown-bug up -d
python3 smoke.py http://localhost:18081 --marker bug-demo1
BOARD_PROFILE=demo-reset BOARD_PORT=18081 docker compose -p shakedown-bug restart app
# Wait until /health returns 200 again, then:
python3 smoke.py http://localhost:18081 --marker bug-demo1 --verify-only --expect-missing
# Fix configuration (does not recover already deleted rows):
BOARD_PROFILE=default BOARD_PORT=18081 docker compose -p shakedown-bug up -d
```

For the Target API, enable with `env.SPRING_PROFILES_ACTIVE=demo-reset` on a dedicated
new project/ID. Removing that profile restores normal persistence. Do not override
SPRING_JPA_HIBERNATE_DDL_AUTO in the bug demo; environment variables override profiles.

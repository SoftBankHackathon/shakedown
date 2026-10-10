# Direct local deployment and automatic reboot recovery — 2026-10-10

Follow-up to the EC2 on-premises simulation in this PR. The two gaps identified
there are now implemented: operator-configured direct delivery and automatic
container/control-service startup. GCP/Azure code was not changed.

## Implementation

- `LOCAL_DELIVERY_MODE=direct` uses `LOCAL_PUBLIC_URL`, `LOCAL_BIND_ADDRESS` and
  `LOCAL_APP_PORT`. Tunnel mode remains default; direct mode creates no cloudflared
  container and logs do not request a nonexistent tunnel service.
- The advertised URL itself must return HTTP 200 before the Target API reports
  ready. Redirects and TLS errors fail. Only operator configuration controls the
  address/port. The engine validates the exact configured origin; an adapter cannot
  return an unrelated destination. The existing HTTPS binding checks remain active.
- One direct endpoint reserves one deployment until DELETE, including failed
  deployments that might still own resources. Requests for a second ID receive
  409, including after service recreation. Same ID/body stays idempotent.
- Generated app/DB/tunnel services use `restart: unless-stopped`. A supplied
  systemd unit starts the loopback Target API after Docker at host startup.
  State and deletion tombstones remain on disk. DELETE removes containers/network
  and retains the database volume; it does not mark volumes disposable.

## Real EC2 test

A new disposable Amazon Linux 2023 t3.medium with encrypted EBS ran the modified
local target. Existing IGW/default route and a public IPv4 address were used.
Only TCP18080 from the test client and the instance's own public `/32` were allowed
(the latter permits the advertised-URL self health probe). SSH/DB/9101 ingress
was not opened. Administration used SSM. No ECS, RDS or Cloudflare resources
participated. The unit was enabled before reboot; credentials were generated on
the instance in a root-owned 0600 environment file.

The unmodified API request schema was used for POST/GET/logs/DELETE; no generated
Compose-file edits or manual `compose up` were used in this run.

1. POST a DB-free Node HTTP app → ready at the configured public origin. Same
   request returned 202; a competing deployment returned 409. DELETE returned 204.
2. POST the Node/PostgreSQL app with DATABASE_URL and initialization command →
   ready. Insert and read a second record. Logs returned 200 without a tunnel.
3. Reboot EC2. A changed Linux boot ID confirmed an actual host reboot. The
   systemd Target API and both app/DB containers recovered automatically. No
   manual startup or deployment POST was issued. Two records remained; the
   developer's machine also retrieved them via public HTTP after recovery.
4. The endpoint reservation still rejected a different deployment ID with 409.
5. DELETE returned 204, repeated DELETE returned 204 and GET returned 404.
   Containers were absent and the PostgreSQL volume was retained.
6. Reboot again and verify deletion stays effective: no containers resurrected,
   the persisted tombstone still returns 404. This is a stop/reboot regression check.

The experiment controller is `infra/local/experiments/direct-api-reboot.py`.
It is intentionally restricted to the documented disposable host layout and test
image. Run phases `prepare`, reboot, `verify`, `stop`, reboot, `verify-stop`.
See `infra/local/README.md` for operator/systemd configuration.

## Limits

This proves real Target API direct deployment and Node/PostgreSQL reboot recovery.
Engine orchestration and URL checks were covered by automated tests; scanner/LLM/
browser end-to-end deployment was not repeated. MySQL/MongoDB receive the same
restart policy and have configuration tests, but their host-reboot recovery was
not live-tested in this run. This is public HTTP testing, not TLS/domain issuance,
VPN/Direct Connect, HA or a real corporate network test.

Applications must retry database connectivity or exit on startup failure for Docker
to restart them. Docker does not enforce Compose health dependencies during host
reboot; an unhealthy process that stays alive needs application-level recovery.
Existing deployments do not acquire the policy until redeployed. An enabled target
unit does not automatically install/start the engine. The target's persisted ready
status is its last successful probe, not continuous monitoring. A stable direct
address is an operator prerequisite (EC2 stop/start can change an unreserved IP).

[Machine-readable evidence](evidence/2026-10-10-direct-deployment-reboot.json).

## Validation and cleanup

Engine suite: 421 passed. Local suite: 16 passed both locally and on EC2.
After the final origin port guard, 12 related engine tests passed again.
A dependency deprecation warning remains; there were no test failures.
The test-only retained PostgreSQL volume was explicitly removed after the DELETE
retention check; containers and volumes were both zero. The dedicated stack reached
DELETE_COMPLETE, EC2 was terminated and no attached volumes remained. Its security
group/SSM role/profile were deleted. Shared VPC/IGW were unchanged.

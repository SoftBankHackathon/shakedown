# Disposable Fargate smoke experiment

This explicit diagnostic harness is **not** the product's architecture deployment
path. It tests one Linux AMD64 task at a time with the catalog's CPU/memory sizes.
It does not test catalog replica counts, multiple AZs, autoscaling, ALB or RDS.

Requires AWS CLI, Docker buildx, Python with httpx and a reviewed build context
containing a `/` endpoint returning `{"experiment":"docker-ai-fallback"}`.
Run `python fargate-smoke.py --help` for required profile, expected account, fresh
stack name, context and evidence output arguments. The profile must be explicit;
this harness permits deliberately selecting default without changing the product
adapter's named-profile requirement. No Claude API key is read by the harness.

It creates a fresh VPC/subnet/IGW, caller-IP-only security group, ECR repository,
ECS cluster, restricted execution role and log group. The task has no application
AWS role or secret. Existing stacks and user policies are not modified. Local
AMD64 build happens before provisioning; ECR credentials use temporary Docker config.

Each size receives a paced 20-second run at 5/50/150 RPS, with at most 50 outstanding
requests. Latency excludes pacing/queue delay; scheduling lag is separate. Since
offered loads differ, this is execution/readiness smoke testing, not a controlled
capacity comparison. A trivial endpoint does not represent a database application.

A 30-minute orchestration deadline and finally cleanup reduce cost, but are **not
a billing hard cap or cloud-side expiry**. Keep the process running: killing it or
losing the laptop can prevent cleanup. Verify cleanup_errors and CloudFormation
DELETE_COMPLETE. On interruption, stop tasks in the experiment cluster before
deleting only that stack. ECR is emptied on deletion; logs, roles and networking
are deleted without Retain. Task definitions are deregistered and deletion requested.

The authorized 2026-10-09 experiment budget was $3. Seoul public Linux/x86 Fargate
rates observed that day were $0.04656/vCPU-hour and $0.00511/GiB-hour. Thirty minutes
at the largest single-task size is $0.05678 compute before ancillary costs/tax.
There is no NAT, ALB or RDS. Actual billing is delayed and is not measured here.
Evidence includes private infrastructure metadata: keep it ignored and publish
only a sanitized summary.

## Full-stack verification

full-stack-check.py takes explicit profile, account, fresh shakedown-full-exp- stack
name and ignored output directory. It uses the repository foundation template with
experiment-only changes: caller-IP ingress, Multi-AZ RDS, Delete policies instead
of Retain/Snapshot, and deletion of automated backups. It builds the known board
sample, then invokes the existing AwsProvider initialize/deploy implementation via
provider-check.ts. A temporary named-profile alias uses the explicitly chosen CLI
identity without modifying the user's AWS config or exposing credentials.

Checks: two healthy application AZs, cross-instance JDBC session and stored post,
CPU target-tracking scale-out (2 to at most 4 tasks), forced RDS failover with data
and session recovery, then bounded scale-in observation (up to 20 minutes for the 15-period alarm, metric publication and task draining). The scale-out CPU target
is deliberately 1% for a short experiment and is raised to 50% for scale-in; these
are test stimuli, not production policy recommendations. The polling interval does
not measure precise outage duration. The total orchestration deadline is one hour,
with additional bounded cleanup time. Keep the process alive until cleanup finishes.

The harness does not implement selected architecture plan -> deployment wiring,
HTTPS, or the production catalog's CPU/memory/task presets. It preserves the existing
provider's 0.5 vCPU/1GiB settings. Account-wide service-linked roles created implicitly
by AWS can outlive a stack; delete only a role proven absent before the experiment
and unused elsewhere. These roles themselves have no hourly resource charge.

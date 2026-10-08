# KTY Board — Shakedown sample (김태윤)

팀 연동은 [김태윤 담당 인수인계](../../infra/local/HANDOFF.md)를 참고하세요.

Java 21 / Spring Boot 4 / Thymeleaf / JPA / **PostgreSQL 17**.
Existing member, post and comment features are retained.

## Run

Use `infra/local/compose.yaml` to run this app and PostgreSQL together:

```sh
cd ../../infra/local
cp .env.example .env
# Set LOCAL_DB_PASSWORD in .env.
docker compose up -d --build
```

Open http://localhost:18080, sign up and log in to create posts.
For host Java execution, set SPRING_DATASOURCE_URL, SPRING_DATASOURCE_USERNAME and
SPRING_DATASOURCE_PASSWORD, then run `bash gradlew bootRun`.
The default JDBC URL is jdbc:postgresql://localhost:5432/board_db; the password has
no hardcoded default. Hibernate infers the PostgreSQL dialect. DB port publishing
is intentionally absent from the Docker configuration.

## Build / test

```sh
bash gradlew test bootJar
# From repository root:
docker build -t shakedown/kty-board:local samples/kty-board
```

Unit/application tests use an isolated H2 database in PostgreSQL compatibility mode.
`infra/local/smoke.py` verifies real PostgreSQL via the running app's HTTP routes.

## Routes for the shakedown owner

- `GET /health`: 200 only when a DB connection is valid; otherwise 503.
- `POST /join`: form fields email, nickname, password.
- `POST /login`: form fields email, password; retain the JSESSIONID cookie.
- `POST /api/posts/write`: form fields title, content; requires the session cookie.
- `GET /api/posts`: JSON list (id, title, content, nickname, viewCount, comments).
- `GET /api/posts/{id}`: JSON details.

Form endpoints redirect; verify session and created rows, not merely the final HTTP
200 login page. `infra/local/smoke.py` demonstrates this flow.

## Data-loss demo

Normal mode uses PostgreSQL with `ddl-auto=update`; rows survive app restarts.
Explicit `SPRING_PROFILES_ACTIVE=demo-reset` uses `ddl-auto=create` and recreates
all tables on every app start. Use only a separate disposable demo DB. See the local
README for reproduction and the fix. The local rehearsal uses this deterministic PostgreSQL-only scenario;
run `npm run demo` in `infra/local` to verify normal → bug → fix automatically.

## Shared-session demo (Local + AWS)

The same PostgreSQL image supports `demo,session-memory` and `demo,session-jdbc`.
The `demo` profile adds an instance ID response header. With two app instances,
memory sessions lose authentication across instances; JDBC sessions preserve it.
Before first JDBC startup, run once with `SPRING_PROFILES_ACTIVE=schema-init`;
it initializes entity and PostgreSQL session tables and exits. It can be repeated
without deleting rows. The local Target API does this automatically. For standalone
Compose, use `docker compose run --rm -e SPRING_PROFILES_ACTIVE=schema-init app`.
Do not use demo-reset with shared-session verification: it is a separate, destructive
DB configuration demonstration on an isolated database.

The boot JAR is `board.jar`; the common Dockerfile runs Java 21 on either architecture.
AWS requires a Linux AMD64 image digest; Local can use that same digest via Docker.

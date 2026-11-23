# AI Workforce Platform

Companies hire AI employees that work like colleagues: in Google Chat, Jira, GitHub and
meetings. Design documents live in [`docs/`](docs/), starting with
[`docs/architecture/core-orchestrator-design.md`](docs/architecture/core-orchestrator-design.md).

## Layout

| Path              | What it is                                                                     |
| ----------------- | ------------------------------------------------------------------------------ |
| `apps/web`        | **web** process: REST API, provider webhooks, SSE (Fastify)                    |
| `apps/worker`     | **worker** process: Temporal workflows and activities                          |
| `apps/egress`     | **egress** process: credential proxy for sandboxes (placeholder until Phase 3) |
| `apps/dashboard`  | Organization dashboard (Next.js), black and white                              |
| `packages/config` | Validated environment config (Zod)                                             |
| `packages/logger` | Structured logging (pino) with correlation ids and OpenTelemetry               |
| `packages/db`     | Postgres access (Kysely) and migrations                                        |

## Run it locally

Requires Node 22+ and pnpm 10. For Postgres and Temporal, either Docker, or Homebrew:
`brew install postgresql@18 pgvector temporal`.

```bash
pnpm install
pnpm dev
```

`pnpm dev` creates `.env` from `.env.example`, starts Postgres and Temporal (Docker if
running, otherwise local binaries under `.data/`), runs migrations, then starts all apps:

- Dashboard: http://localhost:3000
- API: http://localhost:4000 (`/healthz`, `/readyz`, `/v1/meta`)
- Temporal UI: http://localhost:8233

Check the worker end to end with `pnpm --filter @aiw/worker ping`.

## Everyday commands

| Command           | Does                                                     |
| ----------------- | -------------------------------------------------------- |
| `pnpm check`      | lint, formatting, type-check and tests (same as CI)      |
| `pnpm test`       | all tests (DB tests run when `TEST_DATABASE_URL` is set) |
| `pnpm db:migrate` | apply migrations (`:down` reverts one, `:status` lists)  |
| `pnpm build`      | build every app                                          |

A pre-commit hook formats and lints staged files, and scans for secrets when
[gitleaks](https://github.com/gitleaks/gitleaks) is installed. CI runs all checks, a
migration up/down/up cycle, a full-history secret scan and the backend image build.

## Logging conventions

- Use the logger from `@aiw/logger`; `console` is blocked by lint.
- Every line is JSON with `service`, `env`, `version`, and the current context:
  `request_id`, `org_id`, `task_id`, `execution_id`, `workflow_id`, `trace_id`.
- Wrap units of work in `withLogContext({...}, fn)`; add ids learned later with `addLogContext`.
- HTTP: one `request completed` line per request (method, route, status, duration).
  Responses carry `X-Request-Id`; errors are RFC 7807 problems that include `request_id`.
- Temporal: activities log `activity completed` / `activity failed` with workflow id,
  attempt and duration; workflow `log.*` calls flow into the same logger.
- Dashboard: API calls send `X-Request-Id`; error screens show the request or error id;
  browser errors are reported to `POST /v1/client-logs` and logged with `source=dashboard`.
- Secrets (`token`, `password`, `authorization`, `cookie`, ...) are redacted automatically.
  Never log message bodies or query parameters that may hold personal data.

## Dashboard design rules

Black, white and three greys only (`gray-100`, `gray-300`, `gray-600`); no other colors
exist in the theme. States use icons, weight and borders, never color. Every data view
handles loading (skeletons), empty (`EmptyState`) and error (`ErrorState` with request id
and retry) states.

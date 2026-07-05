# @openrupiv/runtime

Serves a compiled openRupiv app directory (ADR-0004): OIDC-authenticated
(ADR-0002/0003), Postgres-backed, with entity CRUD, server-rendered pages,
and workflow enforcement including **n-eyes (distinct-approver) approvals**.

The app directory is data — `spec.json`, `migrations/*.sql`, docs, tests.
All security-relevant behavior (auth, sessions, role guards, approvals)
lives here, exactly once, on the human-review path. A security fix ships as
a runtime upgrade; apps never need regeneration.

## Public API (specs/phase-1-contracts.md §2)

```ts
import {
  configFromEnv,   // env → RuntimeConfig (throws typed errors)
  loadAppDir,      // dir → validated AppSpec (reads spec.json)
  createServer,    // (spec, config[, deps]) → FastifyInstance (for tests)
  serveAppDir,     // migrations + infra tables, then listen
} from "@openrupiv/runtime";
```

`bin/serve.mjs <appDir>` (or `APP_DIR=…`) runs `serveAppDir(configFromEnv())`.
The runtime ships as TypeScript source in v0, so run it under `tsx`:

```sh
corepack pnpm --filter @openrupiv/runtime exec tsx bin/serve.mjs /path/to/app
```

## Configuration (environment)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `OIDC_ISSUER` | yes | — | Issuer URL; discovery is performed against it |
| `OIDC_CLIENT_ID` | yes | — | |
| `OIDC_CLIENT_SECRET` | yes | — | see dev-credential refusal below |
| `OIDC_ROLES_CLAIM` | no | `roles` | ID-token claim carrying the user's roles (string or string[]; use `groups` for Dex groups) |
| `SESSION_SECRET` | yes | — | **≥ 32 chars, enforced**; HMAC key for session cookies |
| `BASE_URL` | no | `http://localhost:<port>` | External URL; used for the OIDC redirect URI |
| `PORT` | no | `3000` | |
| `OPENRUPIV_DEV_MODE` | no | unset | must be exactly `true` to enable dev mode |

All configuration failures throw `RuntimeError` with code `ERR_CONFIG` and a
`details` array listing every problem.

### Dev-credential refusal (ADR-0002)

If `OIDC_CLIENT_SECRET` equals the bundled Compose/Dex dev secret
(`openrupiv-dev-secret`) and `OPENRUPIV_DEV_MODE` is not `true`, the process
**refuses to start** with `ERR_DEV_CREDENTIALS`. This is re-checked inside
`createServer`, so hand-built configs cannot bypass it.

## Authentication

- OIDC only — no password table, no local auth, no anonymous mode (ADR-0003).
- Authorization Code + PKCE via `openid-client` v6 discovery. ID-token
  validation (issuer, audience, expiry, signature via JWKS, nonce) is done by
  the library during the code exchange.
- Identity = `sub`, `email`, and roles from the configurable roles claim.
- Sessions are stateless, HMAC-SHA256-signed cookies (`openrupiv_session`):
  HttpOnly, SameSite=Lax, Path=/, `Secure` unless dev mode, 8 h expiry.
  In-flight login state (state/nonce/PKCE verifier) lives in a second signed
  cookie with a 10 minute expiry.
- Plain-`http` issuers are accepted **only** in dev mode (Dex-in-Compose).
- Every route requires a session except `/healthz` and `/auth/*`.
  Browsers get a 302 to `/auth/login?returnTo=…` (local paths only);
  API clients get `401 { "error": "ERR_UNAUTHENTICATED" }`.

## HTTP surface

| Route | Behavior |
|---|---|
| `GET /healthz` | `{ ok: true }`, unauthenticated (Compose healthcheck) |
| `GET /auth/login` | redirect to IdP (PKCE) |
| `GET /auth/callback` | code exchange → session cookie → 303 to `returnTo` |
| `POST /auth/logout` | clears the session (JSON `{ ok: true }`, or 303 for form posts) |
| `GET /api/<entity>` | list (newest first) |
| `POST /api/<entity>` | create → 201 + record (form posts 303 to the detail page) |
| `GET /api/<entity>/:id` | fetch |
| `PUT /api/<entity>/:id` | partial update of provided fields |
| `POST /api/<entity>/:id/transitions/<name>` | workflow transition (below) |
| `GET /` | index of pages |
| `GET /p/<page>` | server-rendered list / detail (`?id=`) / form page |

Entity names map `VendorApplication` → table `vendor_application`, API path
`/api/vendor-application`; fields map `contactEmail` → `contact_email`, and
reference fields get an `_id` column suffix. No DELETE in v0.

**Workflow state fields are read-only** through create/update
(`400 ERR_STATE_FIELD_READONLY`); the server sets the initial state on
create and transitions are the only writer.

All errors are machine-readable: `{ "error": "<CODE>", "message": …,
"details"?: … }`.

## Workflow transitions and n-eyes enforcement

`POST /api/<entity>/:id/transitions/<transition>` runs in ONE transaction
with the record row locked (`SELECT … FOR UPDATE`), enforcing in order:

1. **State** — record must be in the transition's `from` state, else
   `409 { "error": "ERR_BAD_STATE" }`.
2. **Guard roles** — caller needs one of `guard.roles`, else
   `403 { "error": "ERR_FORBIDDEN_ROLE" }`.
3. **Guard predicates** — all `guard.require` predicates must hold, else
   `409 { "error": "ERR_GUARD_FAILED" }`.
4. **Approval rule** (if `approval { count: n }` is present):
   - approver must hold one of `approval.roles` (defaults to guard roles);
   - one approval per `(entity_table, record_id, transition, approver_sub)`
     is recorded in `workflow_approvals`; the same user approving twice gets
     `409 { "error": "ERR_DUPLICATE_APPROVER" }` and a structured warn log
     (`workflow.duplicate_approver`). A database UNIQUE constraint backs
     this under concurrency.
   - when `COUNT(DISTINCT approver_sub)` reaches `n`, the state flips **in
     the same transaction** as the final approval.

Responses: `{ "status": "pending", "approvals": k, "required": n }` or
`{ "status": "transitioned", "state": "<to>" }`.

## Migrations

At startup `serveAppDir`:

1. creates infra tables idempotently (`_migrations`, `workflow_approvals`,
   `pgcrypto` extension);
2. applies `migrations/*.sql` sorted ascending by filename, each in its own
   transaction, recording each in `_migrations` and skipping already-applied
   files. Forward-only; a failing migration rolls back and aborts startup
   with `ERR_MIGRATION_FAILED`.

## Logging

Structured JSON to stdout, one object per line (`level`, `time`, `msg`,
event fields). Every field passes a redaction helper that replaces values
under keys matching tokens/secrets/passwords/cookies/authorization/… with
`[REDACTED]` — tested. Request logs never include query strings (OAuth codes
travel there) or headers.

## Docker

`packages/runtime/Dockerfile` — build context is the **monorepo root** (the
image needs `packages/spec` too):

```sh
docker build -f packages/runtime/Dockerfile -t openrupiv-runtime .
```

Compose usage (the workspace `docker-compose.yaml` emitted by
`openrupiv new` wires this up):

```yaml
services:
  runtime:
    build:
      context: <monorepo root>
      dockerfile: packages/runtime/Dockerfile
    environment:
      APP_DIR: /app-dir
      DATABASE_URL: postgres://openrupiv:openrupiv@postgres:5432/openrupiv
      OIDC_ISSUER: http://dex:5556
      OIDC_CLIENT_ID: openrupiv-local
      OIDC_CLIENT_SECRET: openrupiv-dev-secret   # DEV ONLY (ADR-0002)
      OPENRUPIV_DEV_MODE: "true"                 # required for the dev secret
      SESSION_SECRET: ${SESSION_SECRET}           # generated into .env
    volumes:
      - ./app:/app-dir:ro
    ports: ["3000:3000"]
    depends_on:
      postgres: { condition: service_healthy }
      dex: { condition: service_started }
```

To point at a real IdP: drop the `dex` service, set `OIDC_ISSUER` /
`OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` to your provider's values, remove
`OPENRUPIV_DEV_MODE`, and serve over HTTPS (cookies are `Secure` outside dev
mode). That is the entire production migration.

## Testing

```sh
corepack pnpm --filter @openrupiv/runtime test
```

Unit tests need **no live Postgres and no live IdP**: the db layer is a
narrow `Queryable`/`Db` interface with an in-memory fake injected in tests
(rollback semantics included, so the n-eyes atomicity guarantee is honestly
exercised), and the OIDC callback flow is tested against an offline fake IdP
that signs real RS256 ID tokens which `openid-client` fully validates.
Live-stack behavior is covered by the Compose e2e stage.

## Security notes for reviewers

Human review required (CLAUDE.md) for: `src/auth.ts` (OIDC + session gate),
`src/session.ts` (cookie signing/verification), `src/config.ts`
(dev-credential refusal, secret length), `src/workflows.ts` (n-eyes
enforcement). CSRF posture in v0: `SameSite=Lax` cookies block cross-site
form POSTs; state-changing endpoints are cookie-authenticated only.

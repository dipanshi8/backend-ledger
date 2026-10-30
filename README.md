# Backend Ledger

A backend financial transaction API built with Node.js and Express. Models users, accounts, and fund transfers using double-entry bookkeeping with MongoDB transactions, ledger-derived balances, Redis-backed rate limiting, and asynchronous email notifications via BullMQ.

## Tech stack

- **Runtime:** Node.js 20+, Express 5, CommonJS
- **Database:** MongoDB (Mongoose) — replica set required for multi-document transactions
- **Auth:** JWT (jsonwebtoken), bcryptjs, cookie-parser
- **Redis:** ioredis, rate-limit-redis, BullMQ
- **Security:** Helmet, CORS, express-rate-limit
- **Email:** Nodemailer (Gmail OAuth2) with transactional outbox pattern
- **Testing:** Node.js built-in test runner, mongodb-memory-server, supertest

## Key features

- **Double-entry ledger:** every transfer creates immutable DEBIT and CREDIT entries
- **Integer paise storage:** amounts stored as integer minor units to avoid floating-point errors
- **Ledger-derived balances:** no stored balance field — computed from ledger entry aggregation
- **MongoDB transactions:** transaction, ledger entries, and notification outbox event commit atomically
- **Idempotency keys:** client-supplied keys prevent duplicate transfers under retries
- **Concurrency protection:** document versioning with write-conflict retries (up to 3)
- **Account ownership:** JWT-derived ownership enforced on all account and transaction reads
- **Redis-backed rate limiting:** shared counters across instances with fail-closed 503 on Redis failure
- **Transactional outbox + BullMQ:** notification events committed with the financial transaction, dispatched asynchronously, processed by a separate worker
- **Graceful shutdown:** orderly resource cleanup on SIGINT/SIGTERM for both API server and worker

## Architecture

```
server.js                       API server: HTTP, MongoDB, Redis, outbox dispatcher
worker.js                       Standalone BullMQ email worker (no HTTP, no dispatcher)
src/
  app.js                        Express app, middleware stack, health endpoints
  config/
    env.js                      Startup environment validation
    db.js                       MongoDB connection lifecycle, readiness state
    redis.js                    Redis singleton client with auto-reconnect
    logger.js                   Structured NDJSON logger (no external dependency)
  controllers/                  Route handlers (auth, account, transaction)
  middleware/
    auth.middleware.js          JWT verification, token blacklist
    error.middleware.js         Centralized sanitized error responses
    rate-limit.middleware.js    Redis-backed limiters, fail-closed policy
  models/                       Mongoose schemas (user, account, transaction, ledger,
                                blacklist, notification-outbox)
  queues/
    email.queue.js              BullMQ queue definition and job producer
    email.processor.js          BullMQ worker processor (worker.js only)
  routes/                       Express routers
  services/
    account-access.service.js   Ownership and visibility checks
    email.service.js             Nodemailer send functions
    outbox-dispatcher.service.js  Polls outbox, submits jobs to BullMQ
  utils/
    money.js                    Rupee/paise validation and conversion
test/                           6 test suites, 139 tests
scripts/                        One-off migration script (review before use)
```

| Process | Command | Role |
|---|---|---|
| API server | `npm run dev` | HTTP requests, outbox dispatcher, MongoDB + Redis |
| Worker | `npm run worker:dev` | BullMQ email jobs only — no HTTP, no dispatcher |

The outbox dispatcher runs **only** in the API server to avoid duplicate dispatch.

## Setup

**Prerequisites:** Node.js 20+, MongoDB replica set, Redis.

```bash
git clone https://github.com/dipanshi8/backend-ledger.git
cd backend-ledger
npm install
cp .env.example .env   # fill in values
npm run dev            # terminal 1 — API server (nodemon)
npm run worker:dev     # terminal 2 — email worker (nodemon)
```

Server starts on `http://localhost:3000` (or `PORT` from `.env`).

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `MONGO_URI` | Always | MongoDB connection string (`mongodb://` or `mongodb+srv://`). Must be a replica set. |
| `JWT_SECRET` | Always | Secret for signing JWTs (`openssl rand -hex 64`). |
| `REDIS_URL` | Outside test mode | Redis connection string, e.g. `redis://localhost:6379`. Required for rate limiting and BullMQ. |
| `PORT` | No | HTTP port. Defaults to `3000`. |
| `NODE_ENV` | No | `development` \| `production` \| `test`. |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins, e.g. `http://localhost:3001`. |
| `EMAIL_USER` | No | Gmail address for OAuth2 email. |
| `CLIENT_ID` | No | Google OAuth2 client ID. |
| `CLIENT_SECRET` | No | Google OAuth2 client secret. |
| `REFRESH_TOKEN` | No | Google OAuth2 refresh token. |
| `SHUTDOWN_TIMEOUT_MS` | No | Graceful shutdown timeout (ms). Defaults to `10000`. |
| `OUTBOX_POLL_INTERVAL_MS` | No | Outbox dispatcher poll interval (ms). Defaults to `10000`. |

Startup fails immediately if `MONGO_URI` or `JWT_SECRET` is missing. Outside test mode, `REDIS_URL` is also required.

## API endpoints

Protected endpoints require a JWT via cookie (`token`) or `Authorization: Bearer <token>`. JWTs expire after 3 days; logout blacklists the token in a TTL-indexed collection. Cookies use `HttpOnly`, `SameSite=Lax`, `Secure` (production).

### Auth — rate-limited (10 req / 15 min / IP)

| Method | Path | Description | Responses |
|---|---|---|---|
| `POST` | `/api/auth/register` | Register user. Body: `{ email, password, name }` | `201` · `400` · `422` (taken) · `429` · `503` |
| `POST` | `/api/auth/login` | Authenticate. Body: `{ email, password }` | `200` · `400` · `401` · `429` · `503` |
| `POST` | `/api/auth/logout` | Blacklist current token | `200` |

NoSQL operator payloads (`{ "$gt": "" }`) are rejected on all auth inputs.

### Accounts — authentication required

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/accounts` | Create account (ownership from JWT, body `user` ignored) |
| `GET` | `/api/accounts` | List caller's accounts |
| `GET` | `/api/accounts/balance/:id` | Balance in rupees (`404` if not owned) |
| `GET` | `/api/accounts/:id/ledger` | Ledger entries in chronological order (`404` if not owned) |

Accounts start `ACTIVE` with currency `INR`. `FROZEN` and `CLOSED` accounts cannot send or receive transfers.

### Transactions — rate-limited (30 req / min / IP)

| Method | Path | Description | Responses |
|---|---|---|---|
| `POST` | `/api/transactions` | Transfer funds. Body: `{ fromAccount, toAccount, amount, idempotencyKey }` | `201` · `200` (replay) · `400` · `409` (conflict) · `503` |
| `GET` | `/api/transactions/:id` | Fetch transaction (`404` if not a party) | `200` · `404` |
| `POST` | `/api/transactions/system/initial-funds` | System-user funding (`403` for regular users) | `201` · `200` · `400` |

Transfer validation: `amount` must be a finite number in rupees, positive, max ₹10,000,000, at most 2 decimal places. Self-transfers, inactive accounts, and cross-currency transfers are rejected.

**Idempotency:** every transfer requires a client-supplied `idempotencyKey`. Same key + same payload returns the original transaction (`200`). Same key + different payload returns `400`. Keys used by other users return `400` without revealing the other transaction.

### Health — public, unauthenticated

| Method | Path | Description |
|---|---|---|
| `GET` | `/health/live` | Liveness — `200 { "status": "ok" }` |
| `GET` | `/health/ready` | Readiness — `200` when MongoDB connected (includes `redis` status); `503` if MongoDB down |
| `GET` | `/` | Legacy liveness — plain text |

Redis disconnection does not cause a 503 on `/health/ready` — the response includes a `redis` field showing current state.

## Engineering decisions

### Financial integrity

- **Integer paise:** all amounts stored as integer minor units (1 rupee = 100 paise). API accepts rupees; conversion is lossless for ≤2 decimal places. This avoids floating-point arithmetic errors.
- **Double-entry ledger:** each transfer creates immutable DEBIT and CREDIT entries for the same amount. Schema pre-hooks prevent modification or deletion.
- **Ledger-derived balances:** computed by aggregating ledger entries (credits − debits). No stored balance field.
- **Atomicity:** transaction document, debit, credit, and notification outbox event all commit or roll back together in a MongoDB session.
- **Concurrency:** sender account is version-incremented within the session for write-lock serialization. Transient conflicts retry up to 3 times with back-off.

### Rate limiting

| Endpoint group | Limit | Window |
|---|---|---|
| Auth (register, login) | 10 requests | 15 minutes per IP |
| Financial writes (transactions, initial-funds) | 30 requests | 1 minute per IP |

Counters are stored in Redis and shared across all instances using the same Redis service. Exceeded limits return `429 { "message": "Too many requests, please try again later" }`.

**Fail-closed policy:** if Redis is unavailable, rate-limited endpoints return `503` instead of falling back to in-memory counters. The API server can start without Redis — rate-limited endpoints stay unavailable until Redis reconnects, then recover automatically without restart. Health endpoints are not rate-limited.

### Asynchronous email notifications

Email delivery is decoupled from the financial API via a transactional outbox:

1. **Atomic write:** when a transfer commits, a notification outbox event is written in the same MongoDB session. Rollbacks leave no orphan event.
2. **Dispatcher:** runs in the API server, polls for `PENDING` outbox events, atomically claims each (`PENDING → DISPATCHING`), submits a BullMQ job with a deterministic ID (`email:<outboxEventId>`), then marks it `DISPATCHED`.
3. **Worker:** the separate `worker.js` process consumes BullMQ jobs and sends emails via Nodemailer. Failed jobs retry **3 times** with exponential back-off (2s, 4s, 8s).

**Crash recovery:**
- Stale `DISPATCHING` claims older than 60 seconds revert to `PENDING` on restart.
- Deterministic job IDs prevent duplicate BullMQ jobs if the dispatcher re-submits after a crash.
- After 5 failed dispatch attempts, the event is marked `FAILED` and retained for manual review (not deleted).

BullMQ provides **at-least-once** processing — duplicate emails are possible in rare recovery scenarios. Exactly-once delivery is not claimed.

Registration emails use the same outbox approach but are created outside a MongoDB transaction (best-effort — a failed outbox write does not block registration).

### Security and operations

- **Helmet:** security headers on all responses (CSP, HSTS, X-Content-Type-Options, X-Frame-Options). `X-Powered-By` removed.
- **NoSQL injection:** auth inputs validated as plain strings before reaching MongoDB queries.
- **Error sanitization:** stack traces, file paths, and database internals never exposed to clients.
- **Request body limit:** 100 kB. Oversized requests return `413`.
- **CORS:** wildcard origins never combined with `credentials: true`. No-`Origin` requests always allowed. Empty `ALLOWED_ORIGINS` denies all cross-origin requests (except test mode).
- **Logging:** structured NDJSON to stdout/stderr. Auth headers, cookies, and passwords never logged. Test mode emits only errors.
- **Graceful shutdown:** on SIGINT/SIGTERM — stop dispatcher → close HTTP → close queue → close Redis → close MongoDB → exit 0. Worker follows the same pattern for its BullMQ worker and Redis.

## Testing

```bash
npm test
```

**139 tests** across 6 files. Uses `mongodb-memory-server` (in-memory replica set) and mocked Redis/BullMQ — no external services required.

Coverage: account ownership and authorization, financial integrity (double-entry balancing, atomicity, concurrency), monetary validation, idempotency, NoSQL injection protection, error sanitization, Helmet headers, CORS, rate limiting, request body limits, environment validation, health endpoints, logger behavior, Redis connection recovery, outbox atomicity, dispatcher claims and stale-claim recovery, duplicate dispatch safety, email queue and processor, worker lifecycle, and financial integrity regressions.

## Limitations

- **Single currency:** only `INR`. Cross-currency transfers rejected.
- **No token rotation:** JWTs expire after 3 days. Revocation requires the logout endpoint.
- **No pagination:** account and ledger endpoints return all records.
- **At-least-once email delivery:** duplicate emails possible in failure/recovery scenarios.
- **Single-instance dispatcher:** multi-instance deployments need an external lock to prevent duplicate dispatch.
- **Replica set required:** MongoDB standalone does not support multi-document transactions.

## Author

Dipanshi Yadav · [GitHub](https://github.com/dipanshi8)

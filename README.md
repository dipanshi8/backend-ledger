# Backend Ledger

A financial transaction API built with Node.js and Express. It models users, accounts, and fund transfers using double-entry bookkeeping, with MongoDB transactions for atomicity and a ledger-derived balance model.

**Tech stack:** Node.js · Express · MongoDB / Mongoose · JWT · bcryptjs · Nodemailer

---

## Architecture

```
server.js              Entry point: env validation → DB connect → HTTP server → graceful shutdown
src/
  app.js               Express app, middleware stack, health endpoints
  config/
    env.js             Startup environment variable validation
    db.js              MongoDB connection lifecycle and readiness state
    logger.js          Lightweight structured JSON logger (no extra dependencies)
  controllers/         Route handlers (auth, account, transaction)
  middleware/
    auth.middleware.js     JWT verification, blacklist check
    error.middleware.js    Centralized sanitized error responses
    rate-limit.middleware.js  express-rate-limit configuration
  models/              Mongoose schemas (user, account, transaction, ledger, blacklist)
  routes/              Express routers
  services/
    account-access.service.js  Ownership and visibility checks
    email.service.js            Best-effort email notifications
  utils/
    money.js           Rupee/paise conversion and monetary validation
test/                  Node.js built-in test runner suites
scripts/               One-off data migration scripts (do not run against production without review)
```

---

## Prerequisites

- Node.js 20 or later
- A MongoDB **replica set** (required for multi-document transactions)
  - Local: [run a single-node replica set](https://www.mongodb.com/docs/manual/tutorial/deploy-replica-set/) or use Docker
  - Cloud: MongoDB Atlas free tier works out of the box

---

## Local setup

```bash
git clone https://github.com/dipanshi8/backend-ledger.git
cd backend-ledger
npm install
cp .env.example .env   # then edit .env with your values
npm run dev            # nodemon, auto-restarts on file changes
```

The server starts on `http://localhost:3000` (or `PORT` from `.env`).

---

## Environment variables

Copy `.env.example` to `.env` and set each value. Never commit `.env`.

| Variable | Required | Description |
|---|---|---|
| `MONGO_URI` | Yes | MongoDB connection string — must start with `mongodb://` or `mongodb+srv://`. Requires a replica set for transactions. |
| `JWT_SECRET` | Yes | Secret for signing JWT tokens. Use a long random string (`openssl rand -hex 64`). |
| `PORT` | No | HTTP port. Defaults to `3000`. |
| `NODE_ENV` | No | `development` \| `production` \| `test`. Affects cookie security and log verbosity. |
| `ALLOWED_ORIGINS` | No | Comma-separated browser origins for CORS, e.g. `http://localhost:3001`. If empty: test mode allows all, other modes deny all cross-origin requests. |
| `EMAIL_USER` | No | Gmail address for OAuth2 email notifications. |
| `CLIENT_ID` | No | Google OAuth2 client ID. |
| `CLIENT_SECRET` | No | Google OAuth2 client secret. |
| `REFRESH_TOKEN` | No | Google OAuth2 refresh token. |
| `SHUTDOWN_TIMEOUT_MS` | No | Graceful shutdown timeout in ms. Defaults to `10000`. |

Startup fails immediately with a clear message if `MONGO_URI` or `JWT_SECRET` is absent or malformed.

---

## Running the server

```bash
npm start        # production (node server.js)
npm run dev      # development (nodemon server.js)
```

Startup sequence:
1. Validate environment variables
2. Connect to MongoDB (exits if this fails)
3. Verify SMTP connection (best-effort, does not block startup)
4. Start HTTP server

---

## Running tests

```bash
npm test
```

Tests use `mongodb-memory-server` (in-memory replica set) — no external database needed. All 90 tests run in a single Node.js process.

---

## Authentication

All protected endpoints require a JWT. The token can be passed in two ways:

- **Cookie:** `token` cookie (set automatically on login/register)
- **Header:** `Authorization: Bearer <token>`

JWTs expire after **3 days**. Logging out blacklists the token in the database (TTL-indexed, auto-expires after 3 days).

Cookie attributes: `HttpOnly`, `SameSite=Lax`, `Secure` (only in production).

---

## API endpoints

### Auth — public, rate-limited (10 requests / 15 minutes per IP)

#### `POST /api/auth/register`
Register a new user.

Request body:
```json
{ "email": "user@example.com", "password": "password123", "name": "Alice" }
```

- `email`: valid email format, max 254 characters
- `password`: string, 6–128 characters
- `name`: string, 1–100 characters, non-blank

Responses: `201 Created` · `400 Bad Request` (validation) · `422 Unprocessable Entity` (email already taken) · `429 Too Many Requests`

#### `POST /api/auth/login`
Authenticate and receive a JWT.

Request body:
```json
{ "email": "user@example.com", "password": "password123" }
```

Responses: `200 OK` · `400 Bad Request` (missing/invalid fields) · `401 Unauthorized` (wrong credentials) · `429 Too Many Requests`

Both endpoints reject NoSQL operator objects (`{ "$gt": "" }`) in place of string values.

#### `POST /api/auth/logout`
Blacklists the current token. Returns `200` whether or not a token was present.

---

### Accounts — authentication required

#### `POST /api/accounts`
Create a new account for the authenticated user. Account ownership is derived from the JWT — any `user` field in the body is ignored.

Response: `201 Created` with the new account object. Accounts start in `ACTIVE` status with currency `INR`.

#### `GET /api/accounts`
List all accounts owned by the authenticated user.

#### `GET /api/accounts/balance/:accountId`
Returns the current balance in rupees for an account the caller owns. Returns `404` for accounts that do not exist or belong to another user — both cases return identical responses.

#### `GET /api/accounts/:accountId/ledger`
Returns all ledger entries for an account the caller owns, in chronological order. Returns `404` as above.

**Account status** affects transfers:

| Status | Can send | Can receive |
|---|---|---|
| `ACTIVE` | Yes | Yes |
| `FROZEN` | No | No |
| `CLOSED` | No | No |

---

### Transactions — authentication required, rate-limited (30 writes / minute per IP)

#### `POST /api/transactions`
Transfer funds between two accounts.

Request body:
```json
{
  "fromAccount": "<accountId>",
  "toAccount":   "<accountId>",
  "amount":      100.50,
  "idempotencyKey": "unique-client-key"
}
```

- `amount`: finite number in rupees, positive, max ₹10,000,000, at most 2 decimal places (no strings, booleans, or objects)
- `fromAccount` must be owned by the authenticated user
- `toAccount` must exist and be reachable (any user's account)
- Self-transfers are rejected
- Both accounts must be `ACTIVE`
- Both accounts must have the same currency (only `INR` is supported)

Responses: `201 Created` · `200 OK` (idempotent replay) · `400 Bad Request` · `409 Conflict` (unresolvable concurrency)

#### `GET /api/transactions/:transactionId`
Fetch a transaction. Returns `404` unless the caller owns the sender or receiver account. Missing and unauthorized transactions return identical responses.

#### `POST /api/transactions/system/initial-funds`
Fund an account from the system user. Requires a token issued to a user with `systemUser: true`. Not available to regular users (returns `403`).

Request body:
```json
{
  "toAccount": "<accountId>",
  "amount": 100,
  "idempotencyKey": "unique-key"
}
```

---

### Health — public, unauthenticated

#### `GET /health/live`
Liveness probe. Returns `200 { "status": "ok" }` as long as the process is running.

#### `GET /health/ready`
Readiness probe. Returns `200 { "status": "ready" }` when MongoDB is connected. Returns `503 { "status": "unavailable", "reason": "database not connected" }` during startup or after a disconnection. Does not expose connection strings or credentials.

#### `GET /`
Legacy liveness check — returns the plain text string `"Ledger Service is up and running"`.

---

## Financial model

### Amounts
- All amounts are stored internally as **integer paise** (1 rupee = 100 paise).
- API inputs and outputs use **rupees** as a decimal number.
- The conversion is lossless for values with at most 2 decimal places.

### Double-entry bookkeeping
Every transfer creates two immutable ledger entries: a DEBIT on the sender's account and a CREDIT on the receiver's account, both for the same amount. Entries can never be modified or deleted.

### Ledger-derived balances
Account balances are computed by aggregating all ledger entries (sum of credits minus sum of debits). There is no stored balance field.

### Atomicity
Each transfer runs inside a MongoDB multi-document session. The transaction document, debit entry, and credit entry are all committed together or all rolled back.

### Concurrency protection
The sender's account document is updated (`version` increment) within the session to obtain a write lock and detect conflicting concurrent transfers. Transient write conflicts are retried up to 3 times with a short back-off.

---

## Idempotency

Every write to `POST /api/transactions` requires a unique `idempotencyKey` supplied by the client.

| Scenario | Response |
|---|---|
| Same key, same payload, transaction completed | `200` with the original transaction |
| Same key, same payload, transaction still pending | `200` with a pending notice |
| Same key, different amount or recipient | `400` |
| Key used by a different user's transaction | `400` (no information about the other transaction is revealed) |

---

## Rate limiting

| Endpoint group | Limit | Window |
|---|---|---|
| `POST /api/auth/register`, `POST /api/auth/login` | 10 requests | 15 minutes per IP |
| `POST /api/transactions`, `POST /api/transactions/system/initial-funds` | 30 requests | 1 minute per IP |

Exceeded limits return `429 Too Many Requests` with a JSON body: `{ "message": "Too many requests, please try again later" }`.

**Known limitation:** Rate-limit counters are stored in process memory and are not shared across multiple application instances. In a multi-process or load-balanced deployment, each instance applies its own limits independently. A shared store (e.g. Redis) is required for cluster-accurate rate limiting.

---

## CORS

Set `ALLOWED_ORIGINS` to a comma-separated list of allowed browser origins:

```
ALLOWED_ORIGINS=http://localhost:3001,https://app.example.com
```

- Wildcard (`*`) origins are never used in combination with `credentials: true`.
- Requests without an `Origin` header (curl, server-to-server) are always allowed.
- In `NODE_ENV=test` with no configured origins, all origins are permitted to support automated tests.
- In all other environments with no configured origins, all cross-origin browser requests are denied.

---

## Security

- **Helmet** sets standard security headers on all responses: CSP, HSTS, X-Content-Type-Options, X-Frame-Options, and others. `X-Powered-By` is removed.
- **JWT tokens** are signed with `JWT_SECRET`. Invalidated tokens are stored in a TTL-indexed blacklist.
- **Password hashing** uses bcryptjs (10 rounds).
- **NoSQL injection protection:** all auth inputs are validated as plain strings before reaching the database query layer.
- **Error sanitization:** stack traces, file paths, and database internals are never returned to clients. All error responses are JSON.

---

## Email notifications

Registration and successful transfers trigger best-effort email notifications via Gmail OAuth2. A failed email does not affect the API response or the committed financial transaction. SMTP configuration is optional — the server starts normally without it.

---

## Logging

Structured JSON logs are written to stdout (all levels) and stderr (errors). In `NODE_ENV=test` only error-level entries are emitted to keep test output clean.

Authorization headers, cookies, and passwords are never logged.

Sample log entry:
```json
{"level":"http","ts":"2026-10-29T10:00:00.000Z","msg":"request","method":"POST","url":"/api/auth/login","status":200,"ms":45,"ip":"127.0.0.1"}
```

---

## Graceful shutdown

On `SIGINT` or `SIGTERM` the server:
1. Stops accepting new connections
2. Waits up to `SHUTDOWN_TIMEOUT_MS` (default 10 s) for in-flight requests to finish
3. Closes the MongoDB connection
4. Exits with code `0`

---

## Known limitations and deployment prerequisites

- **Replica set required:** MongoDB multi-document transactions require a replica set. A standalone MongoDB instance will not work. MongoDB Atlas free tier and a locally configured replica set both work.
- **In-memory rate limiting:** counters reset on restart and are not shared across instances (see Rate limiting above).
- **No token rotation:** JWTs are long-lived (3 days). Revocation requires the logout endpoint.
- **Email delivery:** best-effort only, no retry queue. Failed notifications are logged but not retried.
- **Single currency:** only `INR` is supported. Cross-currency transfers are rejected.
- **No pagination:** `GET /api/accounts` and `GET /api/accounts/:id/ledger` return all records for the authenticated user without pagination.

---

## Author

Dipanshi Yadav · [GitHub](https://github.com/dipanshi8)

# Backend Ledger – Financial Transaction Engine

A backend ledger system built to explore transaction integrity, authentication, idempotency and auditability. It models accounts, fund transfers and double-entry style book keeping.

**Tech stack:** Node.js · Express.js · MongoDB · Mongoose · JWT · bcrypt · Nodemailer

## Key features
- **Authentication:** JWT-based auth, password hashing and protected routes
- **Token revocation:** blacklist for logged-out tokens
- **Double-entry ledger:** each transfer creates linked debit and credit entries
- **Atomic transfers:** MongoDB sessions commit debit, credit and status together
- **Idempotency keys:** duplicate transfer requests are detected
- **Ledger-derived balances:** balances are computed from entries, not stored
- **Account states:** ACTIVE, FROZEN and CLOSED
- **System user:** dedicated flow for initial account funding
- **Email notifications** for completed transfers

## Getting started
**Prerequisites:** Node.js, npm, MongoDB Atlas (transactions need a replica set), and Postman or similar

```bash
git clone https://github.com/dipanshi8/backend-ledger.git
cd backend-ledger
npm install
cp .env.example .env   # then fill in your values
npm run dev
```

Health check: `GET http://localhost:3000/` returns `Ledger Service is up and running`.

## API Endpoints

| Method | Endpoint | Description | Authentication |
|---|---|---|---|
| POST | `/api/auth/register` | Register a new user | Public |
| POST | `/api/auth/login` | Authenticate and obtain a JWT | Public |
| POST | `/api/auth/logout` | Revoke the current token | Required |
| POST | `/api/accounts` | Create a user account | Required |
| POST | `/api/transactions` | Transfer funds between accounts | Required |
| POST | `/api/transactions/system/initial-funds` | Fund an account through the system-user flow | Required system-user authorization |
| GET | `/` | Check whether the API service is running | Public |


## Engineering focus
Database consistency and transaction boundaries, idempotency, ledger-based balances, authentication, data modeling and API design.

## Planned improvements
- Account ownership check on transfers
- Concurrency-safe transfers with a parallel-request test
- Per-user idempotency keys
- Email delivery through a job queue with retries
- Rate limiting, request validation and automated tests


## Author
Dipanshi Yadav · [GitHub](https://github.com/dipanshi8)
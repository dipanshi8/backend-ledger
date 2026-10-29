/**
 * Stage 3B: API Security & Protection Tests
 *
 * Covers:
 *   1. Helmet security headers
 *   2. CORS — allowed origins, disallowed origins, credentialed behaviour
 *   3. Auth rate limiting (login & register)
 *   4. Financial write rate limiting
 *   5. Oversized JSON request body (413)
 *   6. Regression smoke tests for existing auth, error-sanitization,
 *      authorization, and financial-integrity behaviour
 */

const fs = require("node:fs")
if (fs.existsSync("D:\\temp")) {
    process.env.TEMP = "D:\\temp"
    process.env.TMP = "D:\\temp"
}

const { describe, it, before, after } = require("node:test")
const assert = require("node:assert/strict")
const { MongoMemoryReplSet } = require("mongodb-memory-server")
const mongoose = require("mongoose")
const request = require("supertest")

// Must be set before requiring app so the module picks them up
process.env.JWT_SECRET = "test-jwt-secret"
process.env.NODE_ENV = "test"
process.env.EMAIL_USER = "test@example.com"
// No ALLOWED_ORIGINS set — in test mode this allows all origins (see app.js)

let app
let replSet
let userModel
let transactionModel
let ledgerModel

function authHeader(token) {
    return { Authorization: `Bearer ${token}` }
}

async function registerUser(email, name) {
    const res = await request(app)
        .post("/api/auth/register")
        .send({ email, password: "password123", name })
    assert.equal(res.status, 201, `register failed: ${res.text}`)
    return { token: res.body.token, user: res.body.user }
}

async function createAccount(token) {
    const res = await request(app)
        .post("/api/accounts")
        .set(authHeader(token))
        .send({})
    assert.equal(res.status, 201, `createAccount failed: ${res.text}`)
    return res.body.account
}

async function seedCredit(accountId, rupees) {
    const paise = Math.round(rupees * 100)
    const tx = await transactionModel.create({
        fromAccount: accountId,
        toAccount: accountId,
        amount: paise,
        currency: "INR",
        idempotencyKey: `seed-${accountId}-${Date.now()}-${Math.random()}`,
        status: "COMPLETED"
    })
    await ledgerModel.create({
        account: accountId,
        amount: paise,
        transaction: tx._id,
        type: "CREDIT"
    })
    return tx
}

describe("Stage 3B: API Security & Protection", () => {
    before(async () => {
        replSet = await MongoMemoryReplSet.create({
            replSet: { count: 1, storageEngine: "wiredTiger" }
        })
        const uri = replSet.getUri()
        await mongoose.connect(uri)

        const emailService = require("../src/services/email.service")
        emailService.sendRegistrationEmail = async () => {}
        emailService.sendTransactionEmail = async () => {}
        emailService.sendTransactionFailureEmail = async () => {}

        app = require("../src/app")
        userModel = require("../src/models/user.model")
        transactionModel = require("../src/models/transaction.model")
        ledgerModel = require("../src/models/ledger.model")
    })

    after(async () => {
        await mongoose.disconnect()
        if (replSet) await replSet.stop()
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe("1. Helmet Security Headers", () => {
        it("includes X-Content-Type-Options: nosniff on all responses", async () => {
            const res = await request(app).get("/")
            assert.equal(
                res.headers["x-content-type-options"],
                "nosniff",
                "X-Content-Type-Options must be nosniff"
            )
        })

        it("includes X-Frame-Options to prevent clickjacking", async () => {
            const res = await request(app).get("/")
            // Helmet sets SAMEORIGIN or DENY
            const xfo = res.headers["x-frame-options"]
            assert.ok(xfo, "X-Frame-Options header must be present")
            assert.ok(
                xfo === "SAMEORIGIN" || xfo === "DENY",
                `Unexpected X-Frame-Options value: ${xfo}`
            )
        })

        it("includes X-XSS-Protection header", async () => {
            const res = await request(app).get("/")
            // Helmet sets '0' (modern recommendation) or '1; mode=block'
            const xxss = res.headers["x-xss-protection"]
            assert.ok(xxss !== undefined, "X-XSS-Protection must be present")
        })

        it("includes Content-Security-Policy header", async () => {
            const res = await request(app).get("/")
            assert.ok(
                res.headers["content-security-policy"],
                "Content-Security-Policy header must be present"
            )
        })

        it("sets Strict-Transport-Security (HSTS) header", async () => {
            const res = await request(app).get("/")
            assert.ok(
                res.headers["strict-transport-security"],
                "Strict-Transport-Security header must be present"
            )
        })

        it("removes X-Powered-By to hide framework identity", async () => {
            const res = await request(app).get("/")
            assert.equal(
                res.headers["x-powered-by"],
                undefined,
                "X-Powered-By must be absent"
            )
        })

        it("security headers are present on 404 responses too", async () => {
            const res = await request(app).get("/api/nonexistent-route")
            assert.equal(res.status, 404)
            assert.ok(res.headers["x-content-type-options"], "nosniff header expected on 404")
            assert.equal(res.headers["x-powered-by"], undefined)
        })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe("2. CORS", () => {
        it("allows requests with no Origin header (same-origin / server-to-server)", async () => {
            // supertest makes requests without an Origin header by default
            const res = await request(app).get("/")
            assert.equal(res.status, 200)
            // No CORS rejection — no Access-Control-Allow-Origin needed
        })

        it("allows requests from a configured allowed origin", async () => {
            // In test mode with no ALLOWED_ORIGINS all origins are permitted
            const res = await request(app)
                .get("/")
                .set("Origin", "http://localhost:3001")
            assert.equal(res.status, 200)
            // When an Origin matches, the header echoes it back (not *)
            const acao = res.headers["access-control-allow-origin"]
            assert.ok(acao, "Access-Control-Allow-Origin must be present for a known origin")
        })

        it("returns Access-Control-Allow-Credentials true for credentialed origins", async () => {
            const res = await request(app)
                .get("/")
                .set("Origin", "http://localhost:3001")
            assert.equal(
                res.headers["access-control-allow-credentials"],
                "true",
                "Credentials flag must be true for cookie-based auth"
            )
        })

        it("handles preflight OPTIONS request correctly", async () => {
            const res = await request(app)
                .options("/api/auth/login")
                .set("Origin", "http://localhost:3001")
                .set("Access-Control-Request-Method", "POST")
                .set("Access-Control-Request-Headers", "Content-Type,Authorization")

            // 204 is the configured optionsSuccessStatus
            assert.equal(res.status, 204)
            assert.ok(
                res.headers["access-control-allow-methods"],
                "Access-Control-Allow-Methods must be present on preflight"
            )
        })

        it("blocks requests from a disallowed origin in non-test production-like mode", async () => {
            // Temporarily simulate a production environment with a restricted origin list
            const savedEnv = process.env.NODE_ENV
            const savedOrigins = process.env.ALLOWED_ORIGINS

            process.env.NODE_ENV = "production"
            process.env.ALLOWED_ORIGINS = "https://app.example.com"

            // Re-require app with fresh module cache to pick up new env vars
            Object.keys(require.cache).forEach(k => {
                if (k.includes("src\\app") || k.includes("src/app")) {
                    delete require.cache[k]
                }
            })
            const restrictedApp = require("../src/app")

            const res = await request(restrictedApp)
                .get("/")
                .set("Origin", "https://evil.attacker.com")

            // Restore env
            process.env.NODE_ENV = savedEnv
            if (savedOrigins === undefined) {
                delete process.env.ALLOWED_ORIGINS
            } else {
                process.env.ALLOWED_ORIGINS = savedOrigins
            }

            // CORS error — browser receives a non-CORS response (no ACAO header)
            // The server returns 500 from the CORS callback error, but the key
            // assertion is that the CORS header is absent so the browser blocks it.
            const acao = res.headers["access-control-allow-origin"]
            assert.ok(
                !acao || acao !== "https://evil.attacker.com",
                "Disallowed origin must not receive the Access-Control-Allow-Origin header"
            )
        })

        it("never echoes a wildcard '*' as ACAO when credentials are enabled", async () => {
            const res = await request(app)
                .get("/")
                .set("Origin", "http://localhost:3001")

            const acao = res.headers["access-control-allow-origin"]
            assert.notEqual(
                acao,
                "*",
                "Wildcard ACAO must never be used when credentials:true — browsers will block it"
            )
        })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe("3. Auth Rate Limiting (login & register)", () => {
        it("returns 429 and sanitized JSON after exceeding the auth limit", async () => {
            /**
             * Build a minimal isolated Express app with a tight limiter (max=3)
             * so we can exhaust it in a small number of requests without
             * touching the shared production limiter counters.
             */
            const express = require("express")
            const { createTestAuthRateLimiter } = require("../src/middleware/rate-limit.middleware")
            const authController = require("../src/controllers/auth.controller")

            const testApp = express()
            testApp.use(express.json())
            const limiter = createTestAuthRateLimiter(3)
            testApp.post("/api/auth/register", limiter, authController.userRegisterController)

            const unique = Date.now()
            const results = []
            for (let i = 0; i < 5; i++) {
                const res = await request(testApp)
                    .post("/api/auth/register")
                    .send({
                        email: `rl-test-${unique}-${i}@test.com`,
                        password: "password123",
                        name: `User ${i}`
                    })
                results.push(res.status)
            }

            assert.ok(
                results.includes(429),
                `Expected at least one 429, got: ${results.join(",")}`
            )
        })

        it("returns sanitized JSON (not HTML) for 429 responses", async () => {
            const express = require("express")
            const { createTestAuthRateLimiter } = require("../src/middleware/rate-limit.middleware")
            const authController = require("../src/controllers/auth.controller")

            const testApp = express()
            testApp.use(express.json())
            const limiter = createTestAuthRateLimiter(1) // exhaust after 1 request
            testApp.post("/api/auth/login", limiter, authController.userLoginController)

            // First request uses the one allowed slot
            await request(testApp)
                .post("/api/auth/login")
                .send({ email: "x@test.com", password: "pw" })

            // Second request should be rate-limited
            const tooManyRes = await request(testApp)
                .post("/api/auth/login")
                .send({ email: "x@test.com", password: "pw" })

            assert.equal(tooManyRes.status, 429)
            assert.equal(typeof tooManyRes.body, "object")
            assert.ok(tooManyRes.body.message, "429 must have a message field")
            assert.doesNotMatch(tooManyRes.text, /<html/i, "429 must not return HTML")
        })

        it("returns RateLimit headers on responses when limiter is applied", async () => {
            /**
             * Use a plain express app with no DB dependency — just verify the
             * limiter injects the expected draft-7 headers.
             */
            const express = require("express")
            const { createTestAuthRateLimiter } = require("../src/middleware/rate-limit.middleware")

            const testApp = express()
            testApp.use(express.json())
            testApp.get("/probe", createTestAuthRateLimiter(10), (req, res) => res.json({ ok: true }))

            const res = await request(testApp).get("/probe")
            assert.equal(res.status, 200)

            // express-rate-limit draft-7 sends 'ratelimit' (combined) and 'ratelimit-policy'
            const hasRateLimitHeader =
                res.headers["ratelimit"] !== undefined ||
                res.headers["ratelimit-policy"] !== undefined ||
                res.headers["ratelimit-limit"] !== undefined

            assert.ok(
                hasRateLimitHeader,
                `Rate-limit header missing. Got: ${JSON.stringify(Object.keys(res.headers))}`
            )
        })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe("4. Financial Write Rate Limiting", () => {
        it("POST /api/transactions returns 429 after exceeding financial write limit", async () => {
            const express = require("express")
            const { createTestFinancialWriteRateLimiter } = require("../src/middleware/rate-limit.middleware")
            const authMiddleware = require("../src/middleware/auth.middleware")
            const transactionController = require("../src/controllers/transaction.controller")
            const { errorHandler } = require("../src/middleware/error.middleware")

            const alice = await registerUser(`alice-finrl-${Date.now()}@test.com`, "Alice")
            const bob = await registerUser(`bob-finrl-${Date.now()}@test.com`, "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await seedCredit(aAcc._id, 1_000_000)

            // Isolated app with tight limit (max=3)
            const testApp = express()
            testApp.use(express.json())
            const limiter = createTestFinancialWriteRateLimiter(3)
            testApp.post(
                "/api/transactions",
                limiter,
                authMiddleware.authMiddleware,
                transactionController.createTransaction
            )
            testApp.use(errorHandler)

            const results = []
            for (let i = 0; i < 5; i++) {
                const res = await request(testApp)
                    .post("/api/transactions")
                    .set(authHeader(alice.token))
                    .send({
                        fromAccount: aAcc._id,
                        toAccount: bAcc._id,
                        amount: 0.01,
                        idempotencyKey: `finrl-${Date.now()}-${i}-${Math.random()}`
                    })
                results.push(res.status)
                if (res.status === 429) break
            }

            assert.ok(
                results.includes(429),
                `Expected 429 in responses: ${results.join(",")}`
            )
        })

        it("financial write 429 returns sanitized JSON, not HTML", async () => {
            const express = require("express")
            const { createTestFinancialWriteRateLimiter } = require("../src/middleware/rate-limit.middleware")
            const authMiddleware = require("../src/middleware/auth.middleware")
            const transactionController = require("../src/controllers/transaction.controller")
            const { errorHandler } = require("../src/middleware/error.middleware")

            const alice = await registerUser(`alice-finrl2-${Date.now()}@test.com`, "Alice")
            const bob = await registerUser(`bob-finrl2-${Date.now()}@test.com`, "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await seedCredit(aAcc._id, 1_000_000)

            const testApp = express()
            testApp.use(express.json())
            const limiter = createTestFinancialWriteRateLimiter(1)
            testApp.post(
                "/api/transactions",
                limiter,
                authMiddleware.authMiddleware,
                transactionController.createTransaction
            )
            testApp.use(errorHandler)

            // Use the one allowed slot
            await request(testApp)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 0.01,
                    idempotencyKey: `finrl2-first-${Date.now()}`
                })

            // Now rate-limited
            const tooManyRes = await request(testApp)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 0.01,
                    idempotencyKey: `finrl2-second-${Date.now()}`
                })

            assert.equal(tooManyRes.status, 429)
            assert.equal(typeof tooManyRes.body, "object")
            assert.ok(tooManyRes.body.message)
            assert.doesNotMatch(tooManyRes.text, /<html/i)
        })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe("5. Request Body Size Limit", () => {
        it("returns 413 for a JSON body exceeding 100 kB", async () => {
            // Create a payload well over 100 kB
            const oversizedBody = JSON.stringify({
                email: "size@test.com",
                password: "password123",
                name: "A".repeat(200_000)  // ~200 kB
            })

            const res = await request(app)
                .post("/api/auth/register")
                .set("Content-Type", "application/json")
                .send(oversizedBody)

            assert.equal(res.status, 413, `Expected 413, got ${res.status}: ${res.text}`)
        })

        it("413 response is sanitized JSON, not an HTML Express error page", async () => {
            const oversizedBody = JSON.stringify({
                data: "X".repeat(200_000)
            })

            const res = await request(app)
                .post("/api/auth/login")
                .set("Content-Type", "application/json")
                .send(oversizedBody)

            assert.equal(res.status, 413)
            assert.equal(typeof res.body, "object", "Response must be JSON")
            assert.ok(res.body.message, "Response must have a message field")
            assert.doesNotMatch(res.text, /<html/i, "Must not return HTML")
            assert.doesNotMatch(res.text, /PayloadTooLargeError/i, "Must not expose internal error name")
            assert.doesNotMatch(res.text, /node_modules/i, "Must not expose internal paths")
        })

        it("accepts a normal-sized JSON body without issue", async () => {
            const res = await request(app)
                .post("/api/auth/register")
                .send({
                    email: `normal-size-${Date.now()}@test.com`,
                    password: "password123",
                    name: "Normal User"
                })

            assert.equal(res.status, 201)
        })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe("6. Regression — Auth, Error Sanitization & Authorization", () => {
        it("login and register still work correctly after adding security middleware", async () => {
            const unique = Date.now()
            const registerRes = await request(app)
                .post("/api/auth/register")
                .send({
                    email: `regression-${unique}@test.com`,
                    password: "password123",
                    name: "Regression User"
                })
            assert.equal(registerRes.status, 201)
            assert.ok(registerRes.body.token)

            const loginRes = await request(app)
                .post("/api/auth/login")
                .send({ email: `regression-${unique}@test.com`, password: "password123" })
            assert.equal(loginRes.status, 200)
            assert.ok(loginRes.body.token)
        })

        it("unauthenticated requests still return 401", async () => {
            const res = await request(app).get("/api/accounts")
            assert.equal(res.status, 401)
        })

        it("malformed JSON still returns sanitized 400", async () => {
            const res = await request(app)
                .post("/api/auth/login")
                .set("Content-Type", "application/json")
                .send("{ bad json: ")

            assert.equal(res.status, 400)
            assert.equal(res.body.message, "Malformed JSON in request body")
            assert.doesNotMatch(res.text, /<html/i)
        })

        it("404 for unknown routes still returns JSON with security headers", async () => {
            const res = await request(app).get("/api/does-not-exist")
            assert.equal(res.status, 404)
            assert.equal(res.body.message, "Route not found")
            assert.ok(res.headers["x-content-type-options"])
        })

        it("authorization is enforced — user cannot access another user's account", async () => {
            const unique = Date.now()
            const alice = await registerUser(`alice-reg-${unique}@test.com`, "Alice")
            const bob = await registerUser(`bob-reg-${unique}@test.com`, "Bob")
            const aliceAccount = await createAccount(alice.token)

            const res = await request(app)
                .get(`/api/accounts/balance/${aliceAccount._id}`)
                .set(authHeader(bob.token))

            assert.equal(res.status, 404)
        })

        it("NoSQL injection payloads in login still return 400", async () => {
            const injectionPayloads = [
                { email: { $gt: "" }, password: "password123" },
                { email: { $ne: null }, password: "password123" },
                { email: "victim@example.com", password: { $gt: "" } }
            ]

            for (const payload of injectionPayloads) {
                const res = await request(app)
                    .post("/api/auth/login")
                    .send(payload)
                assert.equal(res.status, 400, `Expected 400 for: ${JSON.stringify(payload)}`)
            }
        })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe("7. Regression — Financial Integrity Core", () => {
        it("transfer preserves double-entry balance after security middleware", async () => {
            const unique = Date.now()
            const alice = await registerUser(`alice-fin-${unique}@test.com`, "Alice")
            const bob = await registerUser(`bob-fin-${unique}@test.com`, "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await seedCredit(aAcc._id, 100)

            const res = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 40,
                    idempotencyKey: `fin-reg-${unique}`
                })

            assert.equal(res.status, 201)
            assert.equal(res.body.transaction.status, "COMPLETED")

            const aBal = await request(app)
                .get(`/api/accounts/balance/${aAcc._id}`)
                .set(authHeader(alice.token))
            const bBal = await request(app)
                .get(`/api/accounts/balance/${bAcc._id}`)
                .set(authHeader(bob.token))

            assert.equal(aBal.body.balance, 60)
            assert.equal(bBal.body.balance, 40)
        })

        it("insufficient balance is still rejected cleanly", async () => {
            const unique = Date.now()
            const alice = await registerUser(`alice-insuf-${unique}@test.com`, "Alice")
            const bob = await registerUser(`bob-insuf-${unique}@test.com`, "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await seedCredit(aAcc._id, 10)

            const res = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 50,
                    idempotencyKey: `insuf-reg-${unique}`
                })

            assert.equal(res.status, 400)
            assert.match(res.body.message, /Insufficient balance/i)
        })
    })
})

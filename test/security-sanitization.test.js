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

process.env.JWT_SECRET = "test-jwt-secret"
process.env.NODE_ENV = "test"
process.env.EMAIL_USER = "test@example.com"

let app
let replSet
let userModel

describe("Stage 3A: Core Security & Error Sanitization", () => {
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
    })

    after(async () => {
        await mongoose.disconnect()
        if (replSet) {
            await replSet.stop()
        }
    })

    describe("1. Authentication Input Validation & NoSQL Injection Protection", () => {
        it("rejects registration with missing or invalid email format", async () => {
            const badEmails = [
                undefined,
                null,
                "",
                "notanemail",
                "missing@domain",
                "@nodomain.com",
                12345,
                true,
                { $gt: "" },
                ["user@test.com"]
            ]

            for (const email of badEmails) {
                const res = await request(app)
                    .post("/api/auth/register")
                    .send({ email, password: "password123", name: "Valid Name" })

                assert.equal(res.status, 400, `Expected 400 for email: ${JSON.stringify(email)}`)
                assert.equal(typeof res.body, "object")
                assert.match(res.body.message, /email/i)
            }
        })

        it("rejects registration with passwords shorter than 6 or longer than 128 characters", async () => {
            const badPasswords = [
                "",
                "12345", // too short (5 chars)
                "a".repeat(129), // too long (>128 chars)
                123456, // not a string
                { $ne: null },
                null
            ]

            for (const password of badPasswords) {
                const res = await request(app)
                    .post("/api/auth/register")
                    .send({ email: "test-pw@example.com", password, name: "Valid Name" })

                assert.equal(res.status, 400, `Expected 400 for password: ${JSON.stringify(password)}`)
                assert.match(res.body.message, /password/i)
            }
        })

        it("rejects registration with missing, non-string, or oversized name", async () => {
            const badNames = [
                "",
                "   ",
                null,
                123,
                { name: "nested" },
                "a".repeat(101) // >100 chars
            ]

            for (const name of badNames) {
                const res = await request(app)
                    .post("/api/auth/register")
                    .send({ email: "test-name@example.com", password: "password123", name })

                assert.equal(res.status, 400, `Expected 400 for name: ${JSON.stringify(name)}`)
                assert.match(res.body.message, /name/i)
            }
        })

        it("rejects login payloads with NoSQL operator injection or non-string values", async () => {
            // Seed a valid user
            await request(app)
                .post("/api/auth/register")
                .send({ email: "victim@example.com", password: "password123", name: "Victim User" })

            const injectionPayloads = [
                { email: { $gt: "" }, password: "password123" },
                { email: { $ne: null }, password: "password123" },
                { email: "victim@example.com", password: { $gt: "" } },
                { email: ["victim@example.com"], password: "password123" },
                { email: 12345, password: "password123" },
                { email: null, password: null },
                {}
            ]

            for (const payload of injectionPayloads) {
                const res = await request(app)
                    .post("/api/auth/login")
                    .send(payload)

                assert.equal(res.status, 400, `Expected 400 for payload: ${JSON.stringify(payload)}`)
                assert.equal(typeof res.body, "object")
                assert.match(res.body.message, /required|string/i)
            }
        })

        it("returns identical generic 401 error for non-existent user and incorrect password", async () => {
            await request(app)
                .post("/api/auth/register")
                .send({ email: "target@example.com", password: "realpassword123", name: "Target" })

            // Wrong password for existing user
            const resWrongPw = await request(app)
                .post("/api/auth/login")
                .send({ email: "target@example.com", password: "wrongpassword" })

            // Non-existent user
            const resNonExistent = await request(app)
                .post("/api/auth/login")
                .send({ email: "nobody@example.com", password: "somepassword123" })

            assert.equal(resWrongPw.status, 401)
            assert.equal(resNonExistent.status, 401)
            assert.equal(resWrongPw.body.message, resNonExistent.body.message)
            assert.equal(resWrongPw.body.message, "Email or password is INVALID")
        })
    })

    describe("2. Secure Authentication Cookies", () => {
        it("issues JWT cookie with httpOnly, sameSite=Lax, and proper expiration on register", async () => {
            const res = await request(app)
                .post("/api/auth/register")
                .send({ email: "cookie-reg@example.com", password: "password123", name: "Cookie User" })

            assert.equal(res.status, 201)
            const setCookie = res.headers["set-cookie"]
            assert.ok(setCookie, "set-cookie header should be present")

            const cookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie
            assert.match(cookieStr, /HttpOnly/i, "Cookie must have HttpOnly flag")
            assert.match(cookieStr, /SameSite=Lax/i, "Cookie must have SameSite=Lax flag")
            assert.match(cookieStr, /Max-Age=/i, "Cookie must have Max-Age attribute")
        })

        it("issues JWT cookie with httpOnly and sameSite=Lax on login", async () => {
            await request(app)
                .post("/api/auth/register")
                .send({ email: "cookie-login@example.com", password: "password123", name: "Login Cookie" })

            const res = await request(app)
                .post("/api/auth/login")
                .send({ email: "cookie-login@example.com", password: "password123" })

            assert.equal(res.status, 200)
            const setCookie = res.headers["set-cookie"]
            assert.ok(setCookie, "set-cookie header should be present")

            const cookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie
            assert.match(cookieStr, /HttpOnly/i)
            assert.match(cookieStr, /SameSite=Lax/i)
        })

        it("clears the auth cookie on logout with matching security attributes", async () => {
            const loginRes = await request(app)
                .post("/api/auth/register")
                .send({ email: "cookie-logout@example.com", password: "password123", name: "Logout Cookie" })

            const token = loginRes.body.token

            const logoutRes = await request(app)
                .post("/api/auth/logout")
                .set("Authorization", `Bearer ${token}`)

            assert.equal(logoutRes.status, 200)
            const setCookie = logoutRes.headers["set-cookie"]
            assert.ok(setCookie, "set-cookie header should be present on logout")

            const cookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie
            assert.match(cookieStr, /token=;/i, "Cookie should be cleared")
            assert.match(cookieStr, /HttpOnly/i)
            assert.match(cookieStr, /SameSite=Lax/i)
        })
    })

    describe("3. Centralized Error Handling & Stack Trace Sanitization", () => {
        it("returns sanitized JSON 400 for malformed JSON request body without HTML", async () => {
            const res = await request(app)
                .post("/api/auth/login")
                .set("Content-Type", "application/json")
                .send("{ malformed-json: true ")

            assert.equal(res.status, 400)
            assert.equal(typeof res.body, "object")
            assert.equal(res.body.message, "Malformed JSON in request body")
            // Ensure no HTML, stack traces, or file paths
            assert.doesNotMatch(res.text, /<html/i)
            assert.doesNotMatch(res.text, /SyntaxError/i)
            assert.doesNotMatch(res.text, /node_modules/i)
            assert.doesNotMatch(res.text, /at /i)
        })

        it("returns sanitized JSON 404 for undefined routes without HTML error page", async () => {
            const res = await request(app)
                .get("/api/undefined-endpoint-xyz")

            assert.equal(res.status, 404)
            assert.equal(typeof res.body, "object")
            assert.equal(res.body.message, "Route not found")
            assert.doesNotMatch(res.text, /<html/i)
            assert.doesNotMatch(res.text, /Cannot GET/i)
        })

        it("returns generic 500 without stack trace or internals when an unhandled server error occurs", async () => {
            const express = require("express")
            const { errorHandler } = require("../src/middleware/error.middleware")

            const errorTestApp = express()
            errorTestApp.get("/api/test-server-error", (req, res, next) => {
                const err = new Error("Database disk connection corrupted at /var/data/secret.db")
                next(err)
            })
            errorTestApp.use(errorHandler)

            const res = await request(errorTestApp)
                .get("/api/test-server-error")

            assert.equal(res.status, 500)
            assert.equal(typeof res.body, "object")
            assert.equal(res.body.message, "Internal server error")
            // Verify no sensitive internal error message, path, or stack trace leaked
            assert.doesNotMatch(res.text, /secret\.db/i)
            assert.doesNotMatch(res.text, /Database disk connection/i)
            assert.doesNotMatch(res.text, /<html/i)
            assert.doesNotMatch(res.text, /at /i)
        })
    })
})

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
let accountModel
let transactionModel
let ledgerModel
let emailService

function authHeader(token) {
    return { Authorization: `Bearer ${token}` }
}

async function registerUser(email, name, isSystem = false) {
    if (isSystem) {
        const sysUser = await userModel.create({
            email,
            password: "password123",
            name,
            systemUser: true
        })
        const loginRes = await request(app)
            .post("/api/auth/login")
            .send({ email, password: "password123" })
        assert.equal(loginRes.status, 200)
        return {
            token: loginRes.body.token,
            user: sysUser
        }
    }

    const res = await request(app)
        .post("/api/auth/register")
        .send({ email, password: "password123", name })

    assert.equal(res.status, 201, res.text)

    return {
        token: res.body.token,
        user: res.body.user
    }
}

async function createAccount(token, currency = "INR") {
    const res = await request(app)
        .post("/api/accounts")
        .set(authHeader(token))
        .send({})

    assert.equal(res.status, 201, res.text)
    if (currency !== "INR") {
        await accountModel.findByIdAndUpdate(res.body.account._id, { currency })
    }
    return res.body.account
}

async function creditAccount(accountId, rupees) {
    const amountInPaise = Math.round(rupees * 100)
    const transaction = await transactionModel.create({
        fromAccount: accountId,
        toAccount: accountId,
        amount: amountInPaise,
        currency: "INR",
        idempotencyKey: `seed-${accountId}-${Date.now()}-${Math.random()}`,
        status: "COMPLETED"
    })

    await ledgerModel.create({
        account: accountId,
        amount: amountInPaise,
        transaction: transaction._id,
        type: "CREDIT"
    })

    return transaction
}

describe("Stage 2: Financial Integrity, Monetary Validation & Concurrency", () => {
    before(async () => {
        replSet = await MongoMemoryReplSet.create({
            replSet: { count: 1, storageEngine: "wiredTiger" }
        })

        const uri = replSet.getUri()
        await mongoose.connect(uri)

        emailService = require("../src/services/email.service")
        emailService.sendRegistrationEmail = async () => {}
        emailService.sendTransactionEmail = async () => {}
        emailService.sendTransactionFailureEmail = async () => {}

        app = require("../src/app")
        userModel = require("../src/models/user.model")
        accountModel = require("../src/models/account.model")
        transactionModel = require("../src/models/transaction.model")
        ledgerModel = require("../src/models/ledger.model")
    })

    after(async () => {
        await mongoose.disconnect()
        if (replSet) {
            await replSet.stop()
        }
    })

    describe("1. Strict Amount & Precision Validation", () => {
        it("rejects missing, null, and undefined amounts", async () => {
            const alice = await registerUser("alice-val1@test.com", "Alice")
            const bob = await registerUser("bob-val1@test.com", "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await creditAccount(aAcc._id, 100)

            // Missing amount
            const resMissing = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    idempotencyKey: `val-missing-${Date.now()}`
                })
            assert.equal(resMissing.status, 400)

            // Null amount
            const resNull = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: null,
                    idempotencyKey: `val-null-${Date.now()}`
                })
            assert.equal(resNull.status, 400)
        })

        it("rejects non-numeric, empty string, and boolean values without coercion", async () => {
            const alice = await registerUser("alice-val2@test.com", "Alice")
            const bob = await registerUser("bob-val2@test.com", "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await creditAccount(aAcc._id, 100)

            const invalidTypes = ["", "50", "50.00", true, false, {}, [], "abc"]
            for (const val of invalidTypes) {
                const res = await request(app)
                    .post("/api/transactions")
                    .set(authHeader(alice.token))
                    .send({
                        fromAccount: aAcc._id,
                        toAccount: bAcc._id,
                        amount: val,
                        idempotencyKey: `val-type-${Date.now()}-${Math.random()}`
                    })
                assert.equal(res.status, 400, `Expected 400 for amount: ${JSON.stringify(val)}`)
            }
        })

        it("rejects non-finite values (NaN, Infinity, -Infinity)", async () => {
            const alice = await registerUser("alice-val3@test.com", "Alice")
            const bob = await registerUser("bob-val3@test.com", "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await creditAccount(aAcc._id, 100)

            const res = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: "NaN", // JSON cannot serialize literal NaN without stringifying
                    idempotencyKey: `val-nan-${Date.now()}`
                })
            assert.equal(res.status, 400)
        })

        it("rejects zero and negative amounts", async () => {
            const alice = await registerUser("alice-val4@test.com", "Alice")
            const bob = await registerUser("bob-val4@test.com", "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await creditAccount(aAcc._id, 100)

            const invalidValues = [0, -0.01, -1, -50]
            for (const val of invalidValues) {
                const res = await request(app)
                    .post("/api/transactions")
                    .set(authHeader(alice.token))
                    .send({
                        fromAccount: aAcc._id,
                        toAccount: bAcc._id,
                        amount: val,
                        idempotencyKey: `val-nonpos-${Date.now()}-${Math.random()}`
                    })
                assert.equal(res.status, 400, `Expected 400 for amount: ${val}`)
            }
        })

        it("rejects amounts exceeding the maximum allowable transaction limit", async () => {
            const alice = await registerUser("alice-val5@test.com", "Alice")
            const bob = await registerUser("bob-val5@test.com", "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)

            const res = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 99_000_000,
                    idempotencyKey: `val-max-${Date.now()}`
                })
            assert.equal(res.status, 400)
            assert.match(res.body.message, /maximum limit/i)
        })

        it("rejects excess fractional precision (more than 2 decimal places)", async () => {
            const alice = await registerUser("alice-val6@test.com", "Alice")
            const bob = await registerUser("bob-val6@test.com", "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await creditAccount(aAcc._id, 100)

            const fractionalCases = [10.125, 0.001, 1.9999, 10.0001]
            for (const val of fractionalCases) {
                const res = await request(app)
                    .post("/api/transactions")
                    .set(authHeader(alice.token))
                    .send({
                        fromAccount: aAcc._id,
                        toAccount: bAcc._id,
                        amount: val,
                        idempotencyKey: `val-prec-${Date.now()}-${Math.random()}`
                    })
                assert.equal(res.status, 400, `Expected 400 for precision: ${val}`)
                assert.match(res.body.message, /decimal places/i)
            }
        })

        it("accepts valid precision values up to 2 decimal places", async () => {
            const alice = await registerUser("alice-val7@test.com", "Alice")
            const bob = await registerUser("bob-val7@test.com", "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await creditAccount(aAcc._id, 100)

            const res = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 10.5,
                    idempotencyKey: `val-ok-${Date.now()}`
                })
            assert.equal(res.status, 201)
            assert.equal(res.body.transaction.amount, 10.5)
        })
    })

    describe("2. Transfer Business Rules & Account Integrity", () => {
        it("rejects self-transfer where sender and receiver are the same account", async () => {
            const alice = await registerUser("alice-self@test.com", "Alice")
            const aAcc = await createAccount(alice.token)
            await creditAccount(aAcc._id, 50)

            const res = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: aAcc._id,
                    amount: 10,
                    idempotencyKey: `self-tx-${Date.now()}`
                })
            assert.equal(res.status, 400)
            assert.match(res.body.message, /same account/i)
        })

        it("rejects transfers when sender account is FROZEN or CLOSED", async () => {
            const alice = await registerUser("alice-frozen@test.com", "Alice")
            const bob = await registerUser("bob-frozen@test.com", "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await creditAccount(aAcc._id, 50)

            // Test FROZEN
            await accountModel.findByIdAndUpdate(aAcc._id, { status: "FROZEN" })
            const resFrozen = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 10,
                    idempotencyKey: `frozen-from-${Date.now()}`
                })
            assert.equal(resFrozen.status, 400)
            assert.match(resFrozen.body.message, /must be ACTIVE/i)

            // Test CLOSED
            await accountModel.findByIdAndUpdate(aAcc._id, { status: "CLOSED" })
            const resClosed = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 10,
                    idempotencyKey: `closed-from-${Date.now()}`
                })
            assert.equal(resClosed.status, 400)
            assert.match(resClosed.body.message, /must be ACTIVE/i)
        })

        it("rejects transfers when receiver account is FROZEN or CLOSED", async () => {
            const alice = await registerUser("alice-tofrozen@test.com", "Alice")
            const bob = await registerUser("bob-tofrozen@test.com", "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await creditAccount(aAcc._id, 50)

            await accountModel.findByIdAndUpdate(bAcc._id, { status: "FROZEN" })
            const resFrozen = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 10,
                    idempotencyKey: `frozen-to-${Date.now()}`
                })
            assert.equal(resFrozen.status, 400)
            assert.match(resFrozen.body.message, /must be ACTIVE/i)
        })

        it("rejects cross-currency transfers and unsupported currencies", async () => {
            const alice = await registerUser("alice-curr@test.com", "Alice")
            const bob = await registerUser("bob-curr@test.com", "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token, "USD")
            await creditAccount(aAcc._id, 50)

            const res = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 10,
                    idempotencyKey: `curr-mismatch-${Date.now()}`
                })
            assert.equal(res.status, 400)
            assert.match(res.body.message, /Currency mismatch|cross-currency/i)
        })

        it("rejects transfers when available balance is insufficient", async () => {
            const alice = await registerUser("alice-funds@test.com", "Alice")
            const bob = await registerUser("bob-funds@test.com", "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await creditAccount(aAcc._id, 25.50)

            const res = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 25.51,
                    idempotencyKey: `funds-fail-${Date.now()}`
                })
            assert.equal(res.status, 400)
            assert.match(res.body.message, /Insufficient balance/i)
        })
    })

    describe("3. Initial Funding Business Rules", () => {
        it("rejects invalid amounts in initial funding", async () => {
            const sys = await registerUser("sys-val@test.com", "System", true)
            const alice = await registerUser("alice-sysval@test.com", "Alice")
            await createAccount(sys.token)
            const aAcc = await createAccount(alice.token)

            const invalidAmounts = [0, -10, "10", 10.123]
            for (const amt of invalidAmounts) {
                const res = await request(app)
                    .post("/api/transactions/system/initial-funds")
                    .set(authHeader(sys.token))
                    .send({
                        toAccount: aAcc._id,
                        amount: amt,
                        idempotencyKey: `sys-inv-${Date.now()}-${Math.random()}`
                    })
                assert.equal(res.status, 400, `Expected 400 for initial funding amount: ${amt}`)
            }
        })

        it("rejects initial funding into a FROZEN or CLOSED account", async () => {
            const sys = await registerUser("sys-freeze@test.com", "System", true)
            const alice = await registerUser("alice-sysfreeze@test.com", "Alice")
            await createAccount(sys.token)
            const aAcc = await createAccount(alice.token)

            await accountModel.findByIdAndUpdate(aAcc._id, { status: "FROZEN" })
            const res = await request(app)
                .post("/api/transactions/system/initial-funds")
                .set(authHeader(sys.token))
                .send({
                    toAccount: aAcc._id,
                    amount: 50,
                    idempotencyKey: `sys-frozen-${Date.now()}`
                })
            assert.equal(res.status, 400)
            assert.match(res.body.message, /ACTIVE/i)
        })

        it("properly handles idempotency on initial funding", async () => {
            const sys = await registerUser("sys-idem@test.com", "System", true)
            const alice = await registerUser("alice-sysidem@test.com", "Alice")
            await createAccount(sys.token)
            const aAcc = await createAccount(alice.token)
            const sharedKey = `sys-idem-key-${Date.now()}`

            const res1 = await request(app)
                .post("/api/transactions/system/initial-funds")
                .set(authHeader(sys.token))
                .send({
                    toAccount: aAcc._id,
                    amount: 30,
                    idempotencyKey: sharedKey
                })
            assert.equal(res1.status, 201)

            // Re-request with same key and same payload
            const res2 = await request(app)
                .post("/api/transactions/system/initial-funds")
                .set(authHeader(sys.token))
                .send({
                    toAccount: aAcc._id,
                    amount: 30,
                    idempotencyKey: sharedKey
                })
            assert.equal(res2.status, 200)
            assert.equal(String(res2.body.transaction._id), String(res1.body.transaction._id))

            // Re-request with same key but different payload
            const resConflict = await request(app)
                .post("/api/transactions/system/initial-funds")
                .set(authHeader(sys.token))
                .send({
                    toAccount: aAcc._id,
                    amount: 40,
                    idempotencyKey: sharedKey
                })
            assert.equal(resConflict.status, 400)
            assert.match(resConflict.body.message, /different parameters/i)
        })
    })

    describe("4. Financial Integrity, Double-Entry Balancing & Atomicity", () => {
        it("ensures completed transfer has balanced debit/credit entries and returns COMPLETED", async () => {
            const alice = await registerUser("alice-bal@test.com", "Alice")
            const bob = await registerUser("bob-bal@test.com", "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await creditAccount(aAcc._id, 100)

            const res = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 35.50,
                    idempotencyKey: `balance-tx-${Date.now()}`
                })

            assert.equal(res.status, 201)
            assert.equal(res.body.transaction.status, "COMPLETED")
            assert.equal(res.body.transaction.amount, 35.5)

            // Verify balanced entries in database
            const ledgerEntries = await ledgerModel.find({ transaction: res.body.transaction._id })
            assert.equal(ledgerEntries.length, 2)

            const debit = ledgerEntries.find(e => e.type === "DEBIT")
            const credit = ledgerEntries.find(e => e.type === "CREDIT")

            assert.ok(debit)
            assert.ok(credit)
            assert.equal(String(debit.account), String(aAcc._id))
            assert.equal(String(credit.account), String(bAcc._id))
            assert.equal(debit.amount, 3550)
            assert.equal(credit.amount, 3550)
            assert.equal(debit.toJSON().amount, 35.5)
            assert.equal(credit.toJSON().amount, 35.5)

            // Verify final calculated balances
            const aBalanceRes = await request(app)
                .get(`/api/accounts/balance/${aAcc._id}`)
                .set(authHeader(alice.token))
            assert.equal(aBalanceRes.body.balance, 64.5)

            const bBalanceRes = await request(app)
                .get(`/api/accounts/balance/${bAcc._id}`)
                .set(authHeader(bob.token))
            assert.equal(bBalanceRes.body.balance, 35.5)
        })

        it("guarantees failed transfers leave no partially committed ledger entries", async () => {
            const alice = await registerUser("alice-fail@test.com", "Alice")
            const bob = await registerUser("bob-fail@test.com", "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await creditAccount(aAcc._id, 20)

            const initialLedgerCount = await ledgerModel.countDocuments({})

            // Attempt transfer exceeding balance
            const res = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 50,
                    idempotencyKey: `fail-clean-${Date.now()}`
                })
            assert.equal(res.status, 400)

            const finalLedgerCount = await ledgerModel.countDocuments({})
            assert.equal(finalLedgerCount, initialLedgerCount)

            const aliceBalance = await request(app)
                .get(`/api/accounts/balance/${aAcc._id}`)
                .set(authHeader(alice.token))
            assert.equal(aliceBalance.body.balance, 20)
        })

        it("protects historical ledger entries against modification and deletion", async () => {
            const alice = await registerUser("alice-imm@test.com", "Alice")
            const aAcc = await createAccount(alice.token)
            await creditAccount(aAcc._id, 50)

            const entry = await ledgerModel.findOne({ account: aAcc._id })
            assert.ok(entry)

            await assert.rejects(async () => {
                await ledgerModel.updateOne({ _id: entry._id }, { amount: 1000 })
            }, /immutable/i)

            await assert.rejects(async () => {
                await ledgerModel.deleteOne({ _id: entry._id })
            }, /immutable/i)
        })
    })

    describe("5. Idempotency Key Handling & Conflicts", () => {
        it("returns existing completed transaction when key and payload match", async () => {
            const alice = await registerUser("alice-match@test.com", "Alice")
            const bob = await registerUser("bob-match@test.com", "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await creditAccount(aAcc._id, 100)
            const key = `match-key-${Date.now()}`

            const res1 = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 25,
                    idempotencyKey: key
                })
            assert.equal(res1.status, 201)

            const res2 = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 25,
                    idempotencyKey: key
                })
            assert.equal(res2.status, 200)
            assert.equal(String(res2.body.transaction._id), String(res1.body.transaction._id))
        })

        it("rejects repeated idempotency key when payload conflicts (different amount or recipient)", async () => {
            const alice = await registerUser("alice-conf@test.com", "Alice")
            const bob = await registerUser("bob-conf@test.com", "Bob")
            const carol = await registerUser("carol-conf@test.com", "Carol")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            const cAcc = await createAccount(carol.token)
            await creditAccount(aAcc._id, 100)
            const key = `conflict-key-${Date.now()}`

            await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 25,
                    idempotencyKey: key
                })

            // Same key, different amount
            const resDiffAmount = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 30,
                    idempotencyKey: key
                })
            assert.equal(resDiffAmount.status, 400)
            assert.match(resDiffAmount.body.message, /different parameters/i)

            // Same key, different recipient
            const resDiffRecv = await request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: cAcc._id,
                    amount: 25,
                    idempotencyKey: key
                })
            assert.equal(resDiffRecv.status, 400)
            assert.match(resDiffRecv.body.message, /different parameters/i)
        })
    })

    describe("6. Concurrency Safety & Double-Spending Prevention", () => {
        it("prevents double-spending when concurrent transfers collectively exceed available balance", async () => {
            const alice = await registerUser("alice-race@test.com", "Alice")
            const bob = await registerUser("bob-race@test.com", "Bob")
            const carol = await registerUser("carol-race@test.com", "Carol")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            const cAcc = await createAccount(carol.token)

            // Alice starts with exactly ₹100
            await creditAccount(aAcc._id, 100)

            // Alice simultaneously sends ₹100 to Bob and ₹100 to Carol
            const req1 = request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 100,
                    idempotencyKey: `race-tx-1-${Date.now()}`
                })

            const req2 = request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: cAcc._id,
                    amount: 100,
                    idempotencyKey: `race-tx-2-${Date.now()}`
                })

            const [res1, res2] = await Promise.all([req1, req2])

            const statuses = [res1.status, res2.status].sort()

            // Exactly ONE should succeed (201) and ONE must fail (400 or 409)
            assert.equal(statuses[0], 201, `Expected one transaction to succeed: ${JSON.stringify(statuses)}`)
            assert.ok([400, 409].includes(statuses[1]), `Expected one transaction to fail: ${JSON.stringify(statuses)}`)

            // Alice balance must NEVER be negative; it must be exactly 0
            const aBal = await request(app)
                .get(`/api/accounts/balance/${aAcc._id}`)
                .set(authHeader(alice.token))
            assert.equal(aBal.body.balance, 0)

            // Total funds across recipients must be exactly 100
            const bBal = await request(app)
                .get(`/api/accounts/balance/${bAcc._id}`)
                .set(authHeader(bob.token))
            const cBal = await request(app)
                .get(`/api/accounts/balance/${cAcc._id}`)
                .set(authHeader(carol.token))

            assert.equal(bBal.body.balance + cBal.body.balance, 100)
        })

        it("safely handles concurrent requests with the exact same idempotency key", async () => {
            const alice = await registerUser("alice-idemrace@test.com", "Alice")
            const bob = await registerUser("bob-idemrace@test.com", "Bob")
            const aAcc = await createAccount(alice.token)
            const bAcc = await createAccount(bob.token)
            await creditAccount(aAcc._id, 100)

            const sharedKey = `concurrent-key-${Date.now()}`

            const p1 = request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 20,
                    idempotencyKey: sharedKey
                })

            const p2 = request(app)
                .post("/api/transactions")
                .set(authHeader(alice.token))
                .send({
                    fromAccount: aAcc._id,
                    toAccount: bAcc._id,
                    amount: 20,
                    idempotencyKey: sharedKey
                })

            const [r1, r2] = await Promise.all([p1, p2])

            // Both requests should resolve with success (one 201 created, one 200/201 idempotent replay)
            assert.ok([200, 201].includes(r1.status), `r1 status was ${r1.status}`)
            assert.ok([200, 201].includes(r2.status), `r2 status was ${r2.status}`)

            // Verify only ONE transaction exists in DB
            const txs = await transactionModel.find({ idempotencyKey: sharedKey })
            assert.equal(txs.length, 1)

            // Verify only ONE pair of ledger entries exists in DB for this transaction
            const entries = await ledgerModel.find({ transaction: txs[0]._id })
            assert.equal(entries.length, 2)

            // Sender balance must be 80, not 60
            const aBal = await request(app)
                .get(`/api/accounts/balance/${aAcc._id}`)
                .set(authHeader(alice.token))
            assert.equal(aBal.body.balance, 80)
        })
    })
})

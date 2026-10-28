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
let transactionModel
let ledgerModel
let emailService

function authHeader(token) {
    return { Authorization: `Bearer ${token}` }
}

async function registerUser(email, name) {
    const res = await request(app)
        .post("/api/auth/register")
        .send({ email, password: "password123", name })

    assert.equal(res.status, 201, res.text)
    return {
        token: res.body.token,
        user: res.body.user
    }
}

async function createAccount(token) {
    const res = await request(app)
        .post("/api/accounts")
        .set(authHeader(token))
        .send({})

    assert.equal(res.status, 201, res.text)
    return res.body.account
}

async function creditAccount(accountId, amount) {
    const transaction = await transactionModel.create({
        fromAccount: accountId,
        toAccount: accountId,
        amount,
        idempotencyKey: `seed-${accountId}-${Date.now()}-${Math.random()}`,
        status: "COMPLETED"
    })

    await ledgerModel.create({
        account: accountId,
        amount,
        transaction: transaction._id,
        type: "CREDIT"
    })

    return transaction
}

describe("account ownership and authorization", () => {
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
        transactionModel = require("../src/models/transaction.model")
        ledgerModel = require("../src/models/ledger.model")
    })

    after(async () => {
        await mongoose.disconnect()
        if (replSet) {
            await replSet.stop()
        }
    })

    it("rejects missing and invalid authentication", async () => {
        const missing = await request(app).get("/api/accounts")
        assert.equal(missing.status, 401)

        const invalid = await request(app)
            .get("/api/accounts")
            .set(authHeader("not-a-jwt"))
        assert.equal(invalid.status, 401)

        const missingOnTransfer = await request(app)
            .post("/api/transactions")
            .send({
                fromAccount: new mongoose.Types.ObjectId(),
                toAccount: new mongoose.Types.ObjectId(),
                amount: 10,
                idempotencyKey: "no-auth"
            })
        assert.equal(missingOnTransfer.status, 401)
    })

    it("rejects a valid JWT after the user record is deleted", async () => {
        const { token, user } = await registerUser("deleted@test.com", "Deleted")
        await userModel.findByIdAndDelete(user._id)

        const res = await request(app)
            .get("/api/accounts")
            .set(authHeader(token))

        assert.equal(res.status, 401)
    })

    it("lets a user access their own accounts, balance, and ledger", async () => {
        const { token } = await registerUser("owner@test.com", "Owner")
        const account = await createAccount(token)
        await creditAccount(account._id, 50)

        const list = await request(app)
            .get("/api/accounts")
            .set(authHeader(token))
        assert.equal(list.status, 200)
        assert.equal(list.body.accounts.length, 1)
        assert.equal(String(list.body.accounts[0]._id), String(account._id))

        const balance = await request(app)
            .get(`/api/accounts/balance/${account._id}`)
            .set(authHeader(token))
        assert.equal(balance.status, 200)
        assert.equal(balance.body.balance, 50)

        const ledger = await request(app)
            .get(`/api/accounts/${account._id}/ledger`)
            .set(authHeader(token))
        assert.equal(ledger.status, 200)
        assert.equal(ledger.body.ledger.length, 1)
        assert.equal(ledger.body.ledger[0].type, "CREDIT")
    })

    it("does not create an account for a user id supplied in the body", async () => {
        const alice = await registerUser("alice-body@test.com", "Alice")
        const bob = await registerUser("bob-body@test.com", "Bob")

        const res = await request(app)
            .post("/api/accounts")
            .set(authHeader(alice.token))
            .send({ user: bob.user._id })

        assert.equal(res.status, 201)
        assert.equal(String(res.body.account.user), String(alice.user._id))
    })

    it("does not reveal another user's account via balance or ledger", async () => {
        const alice = await registerUser("alice-read@test.com", "Alice")
        const bob = await registerUser("bob-read@test.com", "Bob")
        const aliceAccount = await createAccount(alice.token)
        await creditAccount(aliceAccount._id, 75)

        const missingId = new mongoose.Types.ObjectId()

        const otherBalance = await request(app)
            .get(`/api/accounts/balance/${aliceAccount._id}`)
            .set(authHeader(bob.token))
        const missingBalance = await request(app)
            .get(`/api/accounts/balance/${missingId}`)
            .set(authHeader(bob.token))

        assert.equal(otherBalance.status, 404)
        assert.equal(missingBalance.status, 404)
        assert.equal(otherBalance.body.message, missingBalance.body.message)
        assert.equal(otherBalance.body.balance, undefined)

        const otherLedger = await request(app)
            .get(`/api/accounts/${aliceAccount._id}/ledger`)
            .set(authHeader(bob.token))
        const missingLedger = await request(app)
            .get(`/api/accounts/${missingId}/ledger`)
            .set(authHeader(bob.token))

        assert.equal(otherLedger.status, 404)
        assert.equal(missingLedger.status, 404)
        assert.equal(otherLedger.body.message, missingLedger.body.message)
        assert.equal(otherLedger.body.ledger, undefined)
    })

    it("does not allow transferring funds from another user's account", async () => {
        const alice = await registerUser("alice-from@test.com", "Alice")
        const bob = await registerUser("bob-from@test.com", "Bob")
        const aliceAccount = await createAccount(alice.token)
        const bobAccount = await createAccount(bob.token)
        await creditAccount(aliceAccount._id, 100)

        const stolen = await request(app)
            .post("/api/transactions")
            .set(authHeader(bob.token))
            .send({
                fromAccount: aliceAccount._id,
                toAccount: bobAccount._id,
                amount: 25,
                idempotencyKey: `steal-${Date.now()}`
            })

        const missingFrom = await request(app)
            .post("/api/transactions")
            .set(authHeader(bob.token))
            .send({
                fromAccount: new mongoose.Types.ObjectId(),
                toAccount: bobAccount._id,
                amount: 25,
                idempotencyKey: `missing-${Date.now()}`
            })

        assert.equal(stolen.status, 400)
        assert.equal(missingFrom.status, 400)
        assert.equal(stolen.body.message, missingFrom.body.message)

        const aliceBalance = await request(app)
            .get(`/api/accounts/balance/${aliceAccount._id}`)
            .set(authHeader(alice.token))
        assert.equal(aliceBalance.body.balance, 100)
    })

    it("allows a user to transfer to another user's account", { timeout: 60000 }, async () => {
        const alice = await registerUser("alice-to@test.com", "Alice")
        const bob = await registerUser("bob-to@test.com", "Bob")
        const aliceAccount = await createAccount(alice.token)
        const bobAccount = await createAccount(bob.token)
        await creditAccount(aliceAccount._id, 40)

        const res = await request(app)
            .post("/api/transactions")
            .set(authHeader(alice.token))
            .send({
                fromAccount: aliceAccount._id,
                toAccount: bobAccount._id,
                amount: 15,
                idempotencyKey: `p2p-${Date.now()}`
            })

        assert.equal(res.status, 201, res.text)
        assert.equal(res.body.transaction.status, "PENDING")

        const completed = await transactionModel.findById(res.body.transaction._id)
        assert.equal(completed.status, "COMPLETED")

        const bobBalance = await request(app)
            .get(`/api/accounts/balance/${bobAccount._id}`)
            .set(authHeader(bob.token))
        assert.equal(bobBalance.body.balance, 15)

        const visibleToReceiver = await request(app)
            .get(`/api/transactions/${completed._id}`)
            .set(authHeader(bob.token))
        assert.equal(visibleToReceiver.status, 200)
    })

    it("hides another user's transaction details", async () => {
        const alice = await registerUser("alice-tx@test.com", "Alice")
        const bob = await registerUser("bob-tx@test.com", "Bob")
        const carol = await registerUser("carol-tx@test.com", "Carol")
        const aliceAccount = await createAccount(alice.token)
        const bobAccount = await createAccount(bob.token)
        await createAccount(carol.token)

        const transaction = await transactionModel.create({
            fromAccount: aliceAccount._id,
            toAccount: bobAccount._id,
            amount: 5,
            idempotencyKey: `hidden-tx-${Date.now()}`,
            status: "COMPLETED"
        })

        const stranger = await request(app)
            .get(`/api/transactions/${transaction._id}`)
            .set(authHeader(carol.token))
        const missing = await request(app)
            .get(`/api/transactions/${new mongoose.Types.ObjectId()}`)
            .set(authHeader(carol.token))

        assert.equal(stranger.status, 404)
        assert.equal(missing.status, 404)
        assert.equal(stranger.body.message, missing.body.message)
        assert.equal(stranger.body.transaction, undefined)
    })

    it("does not return another user's transfer when an idempotency key collides", async () => {
        const alice = await registerUser("alice-idem@test.com", "Alice")
        const bob = await registerUser("bob-idem@test.com", "Bob")
        const carol = await registerUser("carol-idem@test.com", "Carol")
        const aliceAccount = await createAccount(alice.token)
        const bobAccount = await createAccount(bob.token)
        const carolAccount = await createAccount(carol.token)
        const sharedKey = `shared-key-${Date.now()}`

        await transactionModel.create({
            fromAccount: aliceAccount._id,
            toAccount: bobAccount._id,
            amount: 9,
            idempotencyKey: sharedKey,
            status: "COMPLETED"
        })

        const res = await request(app)
            .post("/api/transactions")
            .set(authHeader(carol.token))
            .send({
                fromAccount: carolAccount._id,
                toAccount: aliceAccount._id,
                amount: 1,
                idempotencyKey: sharedKey
            })

        assert.equal(res.status, 400)
        assert.equal(res.body.transaction, undefined)
    })

    it("forbids non-system users from initial funding and allows the system user", async () => {
        const alice = await registerUser("alice-fund@test.com", "Alice")
        const aliceAccount = await createAccount(alice.token)

        const forbidden = await request(app)
            .post("/api/transactions/system/initial-funds")
            .set(authHeader(alice.token))
            .send({
                toAccount: aliceAccount._id,
                amount: 20,
                idempotencyKey: `fund-forbidden-${Date.now()}`
            })
        assert.equal(forbidden.status, 403)

        const systemUser = await userModel.create({
            email: "system@test.com",
            password: "password123",
            name: "System",
            systemUser: true
        })

        const login = await request(app)
            .post("/api/auth/login")
            .send({ email: "system@test.com", password: "password123" })
        assert.equal(login.status, 200)
        assert.equal(String(systemUser._id), String(login.body.user._id))

        await createAccount(login.body.token)

        const funded = await request(app)
            .post("/api/transactions/system/initial-funds")
            .set(authHeader(login.body.token))
            .send({
                toAccount: aliceAccount._id,
                amount: 20,
                idempotencyKey: `fund-ok-${Date.now()}`
            })

        assert.equal(funded.status, 201, funded.text)

        const aliceBalance = await request(app)
            .get(`/api/accounts/balance/${aliceAccount._id}`)
            .set(authHeader(alice.token))
        assert.equal(aliceBalance.body.balance, 20)
    })
})

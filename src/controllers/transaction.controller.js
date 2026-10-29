const transactionModel = require("../models/transaction.model")
const ledgerModel = require("../models/ledger.model")
const accountModel = require("../models/account.model")
const accountAccess = require("../services/account-access.service")
const emailService = require("../services/email.service")
const { validateRupeeAmount, paiseToRupees, SUPPORTED_CURRENCIES } = require("../utils/money")
const mongoose = require("mongoose")

/**
 * Creates a transfer transaction between two accounts.
 */
async function createTransaction(req, res) {
    const { fromAccount, toAccount, amount, idempotencyKey } = req.body

    // 1. Validate required fields (explicit validation, not truthiness)
    if (!fromAccount || !toAccount || !idempotencyKey || amount === undefined || amount === null) {
        return res.status(400).json({
            message: "FromAccount, toAccount, amount and idempotencyKey are required"
        })
    }

    // 2. Strict monetary validation
    const amountValidation = validateRupeeAmount(amount)
    if (!amountValidation.isValid) {
        return res.status(400).json({
            message: amountValidation.error
        })
    }

    // 3. Self-transfer check
    if (String(fromAccount) === String(toAccount)) {
        return res.status(400).json({
            message: "Cannot transfer funds to the same account"
        })
    }

    // 4. Sender must be owned by the authenticated user; recipient must exist.
    const fromUserAccount = await accountAccess.findOwnedAccount(fromAccount, req.user._id)
    const toUserAccount = await accountAccess.findAccountById(toAccount)

    if (!fromUserAccount || !toUserAccount) {
        return res.status(400).json({
            message: "Invalid fromAccount or toAccount"
        })
    }

    // 5. Account status checks
    if (fromUserAccount.status !== "ACTIVE" || toUserAccount.status !== "ACTIVE") {
        return res.status(400).json({
            message: "Both fromAccount and toAccount must be ACTIVE to process transaction"
        })
    }

    // 6. Currency validation
    if (!SUPPORTED_CURRENCIES.includes(fromUserAccount.currency)) {
        return res.status(400).json({
            message: `Unsupported currency: ${fromUserAccount.currency}`
        })
    }

    if (fromUserAccount.currency !== toUserAccount.currency) {
        return res.status(400).json({
            message: "Currency mismatch: cross-currency transfers are not supported"
        })
    }

    // 7. Check idempotency key before starting transaction
    const existingTransaction = await transactionModel.findOne({ idempotencyKey })

    if (existingTransaction) {
        const canAccessExisting = await accountAccess.userIsPartyToTransaction(
            req.user._id,
            existingTransaction
        )

        if (!canAccessExisting) {
            return res.status(400).json({
                message: "Invalid idempotency key"
            })
        }

        // Verify payload parameters match existing transaction
        const isPayloadMatch =
            String(existingTransaction.fromAccount) === String(fromAccount) &&
            String(existingTransaction.toAccount) === String(toAccount) &&
            existingTransaction.amount === amountValidation.paise

        if (!isPayloadMatch) {
            return res.status(400).json({
                message: "Idempotency key already in use with different parameters"
            })
        }

        if (existingTransaction.status === "COMPLETED") {
            return res.status(200).json({
                message: "Transaction already processed",
                transaction: existingTransaction
            })
        }

        if (existingTransaction.status === "PENDING") {
            return res.status(200).json({
                message: "Transaction is still processing"
            })
        }

        if (existingTransaction.status === "FAILED") {
            return res.status(500).json({
                message: "Transaction processing failed, please retry"
            })
        }

        if (existingTransaction.status === "REVERSED") {
            return res.status(500).json({
                message: "Transaction was reversed, please retry"
            })
        }
    }

    // 8. Execute atomic transfer with concurrency serialization
    const maxRetries = 3
    let attempt = 0
    let committedTransaction = null

    while (attempt < maxRetries) {
        attempt++
        let session = null

        try {
            session = await mongoose.startSession()
            session.startTransaction({
                readConcern: { level: "snapshot" },
                writeConcern: { w: "majority" }
            })

            // Serialize concurrent transfers on sender account via document versioning
            const lockedSender = await accountModel.findOneAndUpdate(
                { _id: fromAccount, status: "ACTIVE" },
                { $inc: { version: 1 } },
                { session, returnDocument: 'after' }
            )

            if (!lockedSender) {
                const err = new Error("Sender account is no longer ACTIVE or does not exist")
                err.statusCode = 400
                throw err
            }

            const lockedReceiver = await accountModel.findOne(
                { _id: toAccount, status: "ACTIVE" },
                null,
                { session }
            )

            if (!lockedReceiver) {
                const err = new Error("Both fromAccount and toAccount must be ACTIVE to process transaction")
                err.statusCode = 400
                throw err
            }

            // Derive sender balance in paise inside the session
            const currentBalanceInPaise = await fromUserAccount.getBalanceInPaise({ session })

            if (currentBalanceInPaise < amountValidation.paise) {
                const currentRupees = paiseToRupees(currentBalanceInPaise)
                const requestedRupees = amountValidation.rupees
                const err = new Error(`Insufficient balance. Current balance is ${currentRupees}. Requested amount is ${requestedRupees}`)
                err.statusCode = 400
                throw err
            }

            // Create transaction in PENDING state
            let transactionDoc
            try {
                const created = await transactionModel.create([ {
                    fromAccount,
                    toAccount,
                    amount: amountValidation.paise,
                    currency: fromUserAccount.currency,
                    idempotencyKey,
                    status: "PENDING"
                } ], { session })
                transactionDoc = created[ 0 ]
            } catch (createErr) {
                if (createErr.code === 11000) {
                    // Concurrent idempotency collision
                    const raceErr = new Error("IDEMPOTENCY_RACE")
                    raceErr.isIdempotencyRace = true
                    throw raceErr
                }
                throw createErr
            }

            // Create balanced debit and credit entries
            await ledgerModel.create([ {
                account: fromAccount,
                amount: amountValidation.paise,
                transaction: transactionDoc._id,
                type: "DEBIT"
            } ], { session })

            await ledgerModel.create([ {
                account: toAccount,
                amount: amountValidation.paise,
                transaction: transactionDoc._id,
                type: "CREDIT"
            } ], { session })

            // Mark transaction COMPLETED
            const completed = await transactionModel.findOneAndUpdate(
                { _id: transactionDoc._id },
                { status: "COMPLETED" },
                { session, returnDocument: 'after' }
            )

            await session.commitTransaction()
            committedTransaction = completed
            break
        } catch (error) {
            if (session && session.inTransaction()) {
                await session.abortTransaction()
            }

            // Handle idempotency race condition
            if (error.isIdempotencyRace) {
                const racedTx = await transactionModel.findOne({ idempotencyKey })
                if (racedTx) {
                    const canAccess = await accountAccess.userIsPartyToTransaction(req.user._id, racedTx)
                    if (!canAccess) {
                        return res.status(400).json({ message: "Invalid idempotency key" })
                    }
                    const isMatch =
                        String(racedTx.fromAccount) === String(fromAccount) &&
                        String(racedTx.toAccount) === String(toAccount) &&
                        racedTx.amount === amountValidation.paise
                    if (!isMatch) {
                        return res.status(400).json({ message: "Idempotency key already in use with different parameters" })
                    }
                    return res.status(200).json({
                        message: "Transaction already processed",
                        transaction: racedTx
                    })
                }
            }

            // Retry on transient write conflict
            const isTransient =
                error.hasErrorLabel && error.hasErrorLabel("TransientTransactionError") ||
                error.code === 112 // WriteConflict

            if (isTransient && attempt < maxRetries) {
                await new Promise((resolve) => setTimeout(resolve, attempt * 20))
                continue
            }

            if (error.statusCode) {
                return res.status(error.statusCode).json({
                    message: error.message
                })
            }

            return res.status(400).json({
                message: "Transaction could not be completed, please retry"
            })
        } finally {
            if (session) {
                await session.endSession()
            }
        }
    }

    if (!committedTransaction) {
        return res.status(409).json({
            message: "Transaction conflict under high concurrency, please retry"
        })
    }

    // Asynchronously send email notification without blocking API response
    emailService.sendTransactionEmail(
        req.user.email,
        req.user.name,
        amountValidation.rupees,
        toAccount
    ).catch(() => {})

    return res.status(201).json({
        message: "Transaction completed successfully",
        transaction: committedTransaction
    })
}

/**
 * Creates an initial funds transaction by a system user.
 */
async function createInitialFundsTransaction(req, res) {
    const { toAccount, amount, idempotencyKey } = req.body

    // 1. Validate required fields
    if (!toAccount || !idempotencyKey || amount === undefined || amount === null) {
        return res.status(400).json({
            message: "toAccount, amount and idempotencyKey are required"
        })
    }

    // 2. Strict monetary validation
    const amountValidation = validateRupeeAmount(amount)
    if (!amountValidation.isValid) {
        return res.status(400).json({
            message: amountValidation.error
        })
    }

    // 3. Look up recipient account and verify ACTIVE status
    const toUserAccount = await accountAccess.findAccountById(toAccount)
    if (!toUserAccount) {
        return res.status(400).json({
            message: "Invalid toAccount"
        })
    }

    if (toUserAccount.status !== "ACTIVE") {
        return res.status(400).json({
            message: "toAccount must be ACTIVE to receive initial funds"
        })
    }

    // 4. System account must exist and be ACTIVE
    const fromUserAccount = await accountAccess.findFirstOwnedAccount(req.user._id)
    if (!fromUserAccount) {
        return res.status(400).json({
            message: "System user account not found"
        })
    }

    if (fromUserAccount.status !== "ACTIVE") {
        return res.status(400).json({
            message: "System user account is not ACTIVE"
        })
    }

    // 5. Currency check
    if (fromUserAccount.currency !== toUserAccount.currency) {
        return res.status(400).json({
            message: "Currency mismatch: cross-currency transfers are not supported"
        })
    }

    // 6. Idempotency validation
    const existingTransaction = await transactionModel.findOne({ idempotencyKey })
    if (existingTransaction) {
        const canAccessExisting = await accountAccess.userIsPartyToTransaction(
            req.user._id,
            existingTransaction
        )

        if (!canAccessExisting) {
            return res.status(400).json({
                message: "Invalid idempotency key"
            })
        }

        const isPayloadMatch =
            String(existingTransaction.toAccount) === String(toAccount) &&
            existingTransaction.amount === amountValidation.paise

        if (!isPayloadMatch) {
            return res.status(400).json({
                message: "Idempotency key already in use with different parameters"
            })
        }

        return res.status(200).json({
            message: "Initial funds transaction already processed",
            transaction: existingTransaction
        })
    }

    // 7. Execute atomic transaction with session cleanup
    let session = null
    let completedTransaction = null

    try {
        session = await mongoose.startSession()
        session.startTransaction({
            readConcern: { level: "snapshot" },
            writeConcern: { w: "majority" }
        })

        // Lock recipient account inside session
        const lockedReceiver = await accountModel.findOneAndUpdate(
            { _id: toAccount, status: "ACTIVE" },
            { $inc: { version: 1 } },
            { session, returnDocument: 'after' }
        )

        if (!lockedReceiver) {
            return res.status(400).json({
                message: "toAccount must be ACTIVE to receive initial funds"
            })
        }

        let transactionDoc
        try {
            const created = await transactionModel.create([ {
                fromAccount: fromUserAccount._id,
                toAccount,
                amount: amountValidation.paise,
                currency: fromUserAccount.currency,
                idempotencyKey,
                status: "PENDING"
            } ], { session })
            transactionDoc = created[ 0 ]
        } catch (createErr) {
            if (createErr.code === 11000) {
                // Duplicate idempotency race
                if (session.inTransaction()) {
                    await session.abortTransaction()
                }
                const racedTx = await transactionModel.findOne({ idempotencyKey })
                if (racedTx) {
                    return res.status(200).json({
                        message: "Initial funds transaction already processed",
                        transaction: racedTx
                    })
                }
            }
            throw createErr
        }

        await ledgerModel.create([ {
            account: fromUserAccount._id,
            amount: amountValidation.paise,
            transaction: transactionDoc._id,
            type: "DEBIT"
        } ], { session })

        await ledgerModel.create([ {
            account: toAccount,
            amount: amountValidation.paise,
            transaction: transactionDoc._id,
            type: "CREDIT"
        } ], { session })

        completedTransaction = await transactionModel.findOneAndUpdate(
            { _id: transactionDoc._id },
            { status: "COMPLETED" },
            { session, returnDocument: 'after' }
        )

        await session.commitTransaction()
    } catch (error) {
        if (session && session.inTransaction()) {
            await session.abortTransaction()
        }
        return res.status(400).json({
            message: "Initial funds transaction could not be completed, please retry"
        })
    } finally {
        if (session) {
            await session.endSession()
        }
    }

    return res.status(201).json({
        message: "Initial funds transaction completed successfully",
        transaction: completedTransaction
    })
}

async function getTransactionController(req, res) {
    const { transactionId } = req.params

    const transaction = await accountAccess.findVisibleTransaction(transactionId, req.user._id)

    if (!transaction) {
        return res.status(404).json({
            message: "Transaction not found"
        })
    }

    res.status(200).json({
        transaction
    })
}

module.exports = {
    createTransaction,
    createInitialFundsTransaction,
    getTransactionController
}

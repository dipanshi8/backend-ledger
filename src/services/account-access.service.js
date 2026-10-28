const mongoose = require("mongoose")
const accountModel = require("../models/account.model")
const ledgerModel = require("../models/ledger.model")
const transactionModel = require("../models/transaction.model")

function isValidObjectId(id) {
    return mongoose.Types.ObjectId.isValid(id)
        && String(new mongoose.Types.ObjectId(id)) === String(id)
}

function isOwnedBy(account, userId) {
    if (!account || !userId) {
        return false
    }

    return String(account.user) === String(userId)
}

/**
 * Load an account only if it belongs to the authenticated user.
 * Returns null for missing, invalid, or another user's accounts so callers
 * can use a uniform 404/400 without revealing whether the id exists.
 */
async function findOwnedAccount(accountId, userId) {
    if (!isValidObjectId(accountId) || !userId) {
        return null
    }

    return accountModel.findOne({
        _id: accountId,
        user: userId
    })
}

async function findAccountById(accountId) {
    if (!isValidObjectId(accountId)) {
        return null
    }

    return accountModel.findOne({ _id: accountId })
}

async function findOwnedAccounts(userId) {
    return accountModel.find({ user: userId })
}

async function findFirstOwnedAccount(userId) {
    return accountModel.findOne({ user: userId })
}

async function createAccountForUser(userId) {
    return accountModel.create({
        user: userId
    })
}

async function userIsPartyToTransaction(userId, transaction) {
    if (!userId || !transaction) {
        return false
    }

    const [ fromAccount, toAccount ] = await Promise.all([
        findAccountById(transaction.fromAccount),
        findAccountById(transaction.toAccount)
    ])

    return isOwnedBy(fromAccount, userId) || isOwnedBy(toAccount, userId)
}

async function findVisibleTransaction(transactionId, userId) {
    if (!isValidObjectId(transactionId) || !userId) {
        return null
    }

    const transaction = await transactionModel.findById(transactionId)

    if (!transaction) {
        return null
    }

    const canAccess = await userIsPartyToTransaction(userId, transaction)

    return canAccess ? transaction : null
}

async function findOwnedAccountLedger(accountId, userId) {
    const account = await findOwnedAccount(accountId, userId)

    if (!account) {
        return null
    }

    const entries = await ledgerModel.find({ account: account._id }).sort({ createdAt: 1 })

    return {
        account,
        entries
    }
}

module.exports = {
    isValidObjectId,
    isOwnedBy,
    findOwnedAccount,
    findAccountById,
    findOwnedAccounts,
    findFirstOwnedAccount,
    createAccountForUser,
    userIsPartyToTransaction,
    findVisibleTransaction,
    findOwnedAccountLedger
}

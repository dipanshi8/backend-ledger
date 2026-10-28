const accountAccess = require("../services/account-access.service")


async function createAccountController(req, res) {
    // Ownership comes from the authenticated user only; ignore any user id in the body.
    const account = await accountAccess.createAccountForUser(req.user._id)

    res.status(201).json({
        account
    })
}

async function getUserAccountsController(req, res) {
    const accounts = await accountAccess.findOwnedAccounts(req.user._id)

    res.status(200).json({
        accounts
    })
}

async function getAccountBalanceController(req, res) {
    const { accountId } = req.params

    const account = await accountAccess.findOwnedAccount(accountId, req.user._id)

    if (!account) {
        return res.status(404).json({
            message: "Account not found"
        })
    }

    const balance = await account.getBalance()

    res.status(200).json({
        accountId: account._id,
        balance: balance
    })
}

async function getAccountLedgerController(req, res) {
    const { accountId } = req.params

    const result = await accountAccess.findOwnedAccountLedger(accountId, req.user._id)

    if (!result) {
        return res.status(404).json({
            message: "Account not found"
        })
    }

    res.status(200).json({
        accountId: result.account._id,
        ledger: result.entries
    })
}


module.exports = {
    createAccountController,
    getUserAccountsController,
    getAccountBalanceController,
    getAccountLedgerController
}

const { Router } = require('express')
const authMiddleware = require('../middleware/auth.middleware')
const transactionController = require("../controllers/transaction.controller")
const { financialWriteRateLimiter } = require("../middleware/rate-limit.middleware")

const transactionRoutes = Router()

/**
 * POST /api/transactions/
 * Rate-limited financial write — limiter applied here on the route so it
 * cannot be bypassed by middleware-ordering changes in app.js.
 */
transactionRoutes.post(
    "/",
    financialWriteRateLimiter,
    authMiddleware.authMiddleware,
    transactionController.createTransaction
)

/**
 * POST /api/transactions/system/initial-funds
 * System-initiated funding — same write rate limit applies.
 */
transactionRoutes.post(
    "/system/initial-funds",
    financialWriteRateLimiter,
    authMiddleware.authSystemUserMiddleware,
    transactionController.createInitialFundsTransaction
)

/**
 * GET /api/transactions/:transactionId
 * Read-only — no write rate limiter needed.
 */
transactionRoutes.get(
    "/:transactionId",
    authMiddleware.authMiddleware,
    transactionController.getTransactionController
)

module.exports = transactionRoutes

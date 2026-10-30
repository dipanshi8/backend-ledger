/**
 * API server entry point
 *
 * Startup sequence:
 *   1. Load .env
 *   2. Validate required environment variables (fails fast if missing)
 *   3. Connect to MongoDB (exits on failure)
 *   4. Connect to Redis — if the connection fails the process continues,
 *      but all rate-limited endpoints will return 503 until Redis is available
 *   5. Reinitialise rate limiters with the Redis-backed store
 *   6. Recover stale outbox events from a previous crash
 *   7. Start the outbox dispatcher polling loop
 *   8. Verify SMTP connection (best-effort, does not block startup)
 *   9. Start the HTTP server
 *
 * Graceful shutdown (SIGINT / SIGTERM):
 *   1. Stop the outbox dispatcher
 *   2. Stop accepting new HTTP connections
 *   3. Wait up to SHUTDOWN_TIMEOUT_MS for in-flight requests to finish
 *   4. Close the email queue producer
 *   5. Close the Redis connection
 *   6. Close the MongoDB connection
 *   7. Exit cleanly
 *
 * The worker process (worker.js) runs the BullMQ email worker separately.
 * The outbox dispatcher runs only here — not in the worker — to avoid
 * duplicate dispatch loops.
 */

require("dotenv").config()

const { validateEnv } = require("./src/config/env")
const { logger } = require("./src/config/logger")

// ── 1. Validate environment ──────────────────────────────────────────────────
try {
    validateEnv()
} catch (err) {
    console.error(`[startup] Environment validation failed:\n  ${err.message}`)
    process.exit(1)
}

const { connectToDB, disconnectDB } = require("./src/config/db")
const { connectRedis, disconnectRedis } = require("./src/config/redis")
const { resetLimiters } = require("./src/middleware/rate-limit.middleware")
const { startDispatcher, stopDispatcher, recoverPendingEvents } = require("./src/services/outbox-dispatcher.service")
const { closeEmailQueue } = require("./src/queues/email.queue")
const { verifyEmailConnection } = require("./src/services/email.service")
const app = require("./src/app")

const PORT = parseInt(process.env.PORT, 10) || 3000
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 10_000
const OUTBOX_POLL_INTERVAL_MS = parseInt(process.env.OUTBOX_POLL_INTERVAL_MS, 10) || 10_000

let server = null
let isShuttingDown = false

// ── Startup ──────────────────────────────────────────────────────────────────
async function start() {
    // MongoDB — fail fast
    try {
        await connectToDB()
    } catch (err) {
        logger.error("[startup] MongoDB connection failed, aborting", { error: err.message })
        process.exit(1)
    }

    // Connect to Redis. If this fails, the process continues but rate-limited
    // endpoints will return 503 until Redis becomes available.
    await connectRedis()

    // Reinitialise rate limiters with the Redis-backed store now that Redis is up.
    // If Redis did not connect, resetLimiters() is a no-op and the fail-closed
    // guard in each limiter will return 503 on every rate-limited request.
    resetLimiters()

    // Recover pending outbox events from a previous crash
    try {
        await recoverPendingEvents()
    } catch (err) {
        logger.warn("[startup] Outbox recovery check failed", { error: err.message })
    }

    // Start the outbox dispatcher (only in non-test environments)
    if (process.env.NODE_ENV !== "test") {
        startDispatcher(OUTBOX_POLL_INTERVAL_MS)
    }

    // Verify SMTP — best-effort
    verifyEmailConnection().catch(() => {})

    // Start HTTP server
    server = app.listen(PORT, () => {
        logger.info("[startup] Server started", {
            port: PORT,
            env: process.env.NODE_ENV || "development"
        })
    })

    server.on("error", (err) => {
        logger.error("[startup] HTTP server error", { error: err.message })
        process.exit(1)
    })
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
    if (isShuttingDown) return
    isShuttingDown = true

    logger.info(`[shutdown] Received ${signal}, shutting down gracefully`)

    const forceExit = setTimeout(() => {
        logger.error("[shutdown] Graceful shutdown timed out, forcing exit")
        process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    forceExit.unref()

    // Stop the outbox dispatcher first — no new dispatch attempts
    stopDispatcher()

    // Stop accepting new HTTP connections
    if (server) {
        await new Promise((resolve) => server.close(resolve))
        logger.info("[shutdown] HTTP server closed")
    }

    // Close the email queue (API-side producer connection)
    try {
        await closeEmailQueue()
    } catch (err) {
        logger.warn("[shutdown] Error closing email queue", { error: err.message })
    }

    // Close Redis
    try {
        await disconnectRedis()
    } catch (err) {
        logger.warn("[shutdown] Error closing Redis connection", { error: err.message })
    }

    // Close MongoDB
    try {
        await disconnectDB()
    } catch (err) {
        logger.error("[shutdown] Error closing database connection", { error: err.message })
    }

    clearTimeout(forceExit)
    logger.info("[shutdown] Clean exit")
    process.exit(0)
}

process.on("SIGINT",  () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

process.on("uncaughtException", (err) => {
    logger.error("[process] Uncaught exception", { error: err.message, stack: err.stack })
    shutdown("uncaughtException")
})

process.on("unhandledRejection", (reason) => {
    logger.error("[process] Unhandled rejection", {
        error: reason instanceof Error ? reason.message : String(reason)
    })
})

start()

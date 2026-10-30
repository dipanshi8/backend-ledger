/**
 * Worker entry point — Stage 4 Part D
 *
 * Runs the BullMQ email worker. Does NOT accept HTTP requests and does NOT
 * run the outbox dispatcher (that runs in the API server only to avoid
 * duplicate dispatch loops).
 *
 * Run separately from the API server:
 *
 *   npm run worker        # production
 *   npm run worker:dev    # development (nodemon)
 *
 * Startup sequence:
 *   1. Load .env
 *   2. Validate environment variables
 *   3. Connect to Redis (required for BullMQ)
 *   4. Start the BullMQ email worker
 *
 * Graceful shutdown (SIGINT / SIGTERM):
 *   1. Close the BullMQ worker (waits for in-flight jobs)
 *   2. Close the email queue
 *   3. Close Redis
 *   4. Exit cleanly
 *
 * If Redis is unavailable at startup, the worker exits — it cannot function
 * without Redis.
 */

require("dotenv").config()

const { validateEnv } = require("./src/config/env")
const { logger } = require("./src/config/logger")

try {
    validateEnv()
} catch (err) {
    console.error(`[worker] Environment validation failed:\n  ${err.message}`)
    process.exit(1)
}

const { connectRedis, disconnectRedis, redisReady } = require("./src/config/redis")
const { startEmailWorker, stopEmailWorker } = require("./src/queues/email.processor")
const { closeEmailQueue } = require("./src/queues/email.queue")

const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 10_000

let emailWorker = null
let isShuttingDown = false

async function start() {
    // Redis — required for BullMQ
    await connectRedis()
    if (!redisReady.connected) {
        logger.error("[worker] Redis not available — worker cannot function without Redis")
        process.exit(1)
    }

    // Start the BullMQ email worker
    emailWorker = startEmailWorker()
    if (!emailWorker) {
        logger.error("[worker] Failed to start email worker")
        process.exit(1)
    }

    logger.info("[worker] Worker started")
}

async function shutdown(signal) {
    if (isShuttingDown) return
    isShuttingDown = true

    logger.info(`[worker] Received ${signal}, shutting down gracefully`)

    const forceExit = setTimeout(() => {
        logger.error("[worker] Graceful shutdown timed out, forcing exit")
        process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    forceExit.unref()

    // Close the email worker (waits for in-flight jobs to finish)
    try {
        await stopEmailWorker(emailWorker)
    } catch (err) {
        logger.warn("[worker] Error stopping email worker", { error: err.message })
    }

    // Close the email queue
    try {
        await closeEmailQueue()
    } catch (err) {
        logger.warn("[worker] Error closing email queue", { error: err.message })
    }

    // Close Redis
    try {
        await disconnectRedis()
    } catch (err) {
        logger.warn("[worker] Error closing Redis", { error: err.message })
    }

    clearTimeout(forceExit)
    logger.info("[worker] Clean exit")
    process.exit(0)
}

process.on("SIGINT",  () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

process.on("uncaughtException", (err) => {
    logger.error("[worker] Uncaught exception", { error: err.message, stack: err.stack })
    shutdown("uncaughtException")
})

process.on("unhandledRejection", (reason) => {
    logger.error("[worker] Unhandled rejection", {
        error: reason instanceof Error ? reason.message : String(reason)
    })
})

start()

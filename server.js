/**
 * Application entry point — Stage 3C
 *
 * Startup sequence:
 *   1. Load .env
 *   2. Validate required environment variables (fail fast before any I/O)
 *   3. Connect to MongoDB (fail fast if unavailable)
 *   4. Verify email SMTP connection (best-effort — does not abort startup)
 *   5. Start the HTTP server
 *
 * Graceful shutdown (SIGINT / SIGTERM):
 *   1. Stop accepting new connections (server.close)
 *   2. Wait up to SHUTDOWN_TIMEOUT_MS for in-flight requests to finish
 *   3. Close the database connection
 *   4. Exit cleanly
 *
 * The Express app module is imported after env validation so that middleware
 * registered at module-load time (e.g. CORS origin parsing) sees the validated
 * env vars.  Importing the app does not open any network connections; that is
 * done here explicitly.
 */

require("dotenv").config()

const { validateEnv } = require("./src/config/env")
const { logger } = require("./src/config/logger")

// ── 1. Validate environment before doing anything else ────────────────────────
try {
    validateEnv()
} catch (err) {
    // Use console.error directly — logger depends on env vars being valid
    console.error(`[startup] Environment validation failed:\n  ${err.message}`)
    process.exit(1)
}

const { connectToDB, disconnectDB } = require("./src/config/db")
const { verifyEmailConnection } = require("./src/services/email.service")
const app = require("./src/app")

const PORT = parseInt(process.env.PORT, 10) || 3000
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 10_000

let server = null
let isShuttingDown = false

// ── 2–5. Startup ─────────────────────────────────────────────────────────────
async function start() {
    // Connect to MongoDB — if this fails the process exits; no point serving traffic
    try {
        await connectToDB()
    } catch (err) {
        logger.error("[startup] MongoDB connection failed, aborting", { error: err.message })
        process.exit(1)
    }

    // Verify SMTP — best-effort only, does not block startup
    verifyEmailConnection().catch(() => {})

    // Start HTTP server
    server = app.listen(PORT, () => {
        logger.info("[startup] Server started", { port: PORT, env: process.env.NODE_ENV || "development" })
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

    // Hard exit if shutdown takes too long
    const forceExit = setTimeout(() => {
        logger.error("[shutdown] Graceful shutdown timed out, forcing exit")
        process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    forceExit.unref() // do not prevent natural process exit

    // Stop accepting new connections; wait for in-flight requests
    if (server) {
        await new Promise((resolve) => server.close(resolve))
        logger.info("[shutdown] HTTP server closed")
    }

    // Close database connection
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

// ── Uncaught errors ───────────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
    logger.error("[process] Uncaught exception", { error: err.message, stack: err.stack })
    shutdown("uncaughtException")
})

process.on("unhandledRejection", (reason) => {
    logger.error("[process] Unhandled rejection", {
        error: reason instanceof Error ? reason.message : String(reason)
    })
    // Do not exit — unhandled rejections in async route handlers are common
    // and already handled by Express's next(err) path.
})

start()

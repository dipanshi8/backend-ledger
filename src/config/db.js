/**
 * Database connection — Stage 3C
 *
 * Design decisions:
 *  - connectToDB() returns a Promise so callers can await it and sequence
 *    startup correctly (do not serve requests before the DB is ready).
 *  - A second call while a connection is already open is a no-op.
 *  - readinessState exports a live boolean used by the /health/ready endpoint.
 *  - No auto-connect on module load — the server entry point calls this
 *    explicitly after env validation.
 *  - disconnectDB() is exported for graceful shutdown and test teardown.
 */

const mongoose = require("mongoose")
const { logger } = require("./logger")

/** Tracks whether Mongoose has an open, usable connection. */
const readinessState = {
    dbReady: false
}

/**
 * Opens the MongoDB connection.
 * Resolves when Mongoose reports readyState === 1 (connected).
 * Rejects if the initial connection attempt fails.
 *
 * @returns {Promise<void>}
 */
async function connectToDB() {
    // Mongoose readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
    if (mongoose.connection.readyState === 1) {
        logger.debug("[db] Already connected, skipping reconnect")
        return
    }
    if (mongoose.connection.readyState === 2) {
        logger.debug("[db] Connection already in progress, waiting")
        await new Promise((resolve, reject) => {
            mongoose.connection.once("connected", resolve)
            mongoose.connection.once("error", reject)
        })
        return
    }

    try {
        await mongoose.connect(process.env.MONGO_URI)
        readinessState.dbReady = true
        logger.info("[db] Connected to MongoDB")
    } catch (err) {
        readinessState.dbReady = false
        logger.error("[db] Failed to connect to MongoDB", { error: err.message })
        throw err
    }

    // Keep readiness state in sync with Mongoose lifecycle events
    mongoose.connection.on("disconnected", () => {
        readinessState.dbReady = false
        logger.warn("[db] MongoDB disconnected")
    })
    mongoose.connection.on("reconnected", () => {
        readinessState.dbReady = true
        logger.info("[db] MongoDB reconnected")
    })
    mongoose.connection.on("error", (err) => {
        readinessState.dbReady = false
        logger.error("[db] MongoDB connection error", { error: err.message })
    })
}

/**
 * Closes the MongoDB connection cleanly.
 * Used during graceful shutdown and in test teardown.
 *
 * @returns {Promise<void>}
 */
async function disconnectDB() {
    if (mongoose.connection.readyState === 0) {
        return
    }
    await mongoose.disconnect()
    readinessState.dbReady = false
    logger.info("[db] Disconnected from MongoDB")
}

module.exports = { connectToDB, disconnectDB, readinessState }

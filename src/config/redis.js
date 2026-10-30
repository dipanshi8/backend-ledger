/**
 * Redis connection lifecycle
 *
 * Exports a singleton ioredis client used by:
 *   - rate-limit-redis (shared rate-limit counters)
 *   - BullMQ (email job queue)
 *
 * connectRedis() does not throw on failure. If Redis is unavailable at
 * startup, the API server continues, but all rate-limited endpoints return
 * 503 (fail-closed) until Redis reconnects.
 *
 * The client instance is kept alive during reconnect attempts so that
 * ioredis can recover automatically. Lifecycle event handlers are registered
 * before the initial connection attempt so they fire during reconnects as
 * well. On reconnection, resetLimiters() is called to install the
 * Redis-backed rate-limit store.
 *
 * In test mode (NODE_ENV=test), Redis is never connected — rate limiters
 * skip enforcement and the outbox dispatcher is not started.
 */

const Redis = require("ioredis")
const { logger } = require("./logger")

const redisReady = {
    connected: false
}

let client = null

/**
 * Returns the cached Redis client, or null if not yet created.
 * The client may exist but not be in a "ready" state during reconnection.
 *
 * @returns {import("ioredis").Redis | null}
 */
function getRedisClient() {
    return client
}

/**
 * Opens the Redis connection. Resolves when the client first becomes ready,
 * or when the initial connection attempt fails.
 *
 * Does NOT throw — callers check redisReady.connected afterwards.
 *
 * @returns {Promise<void>}
 */
async function connectRedis() {
    if (client) {
        // Client already created. If it's ready, return immediately.
        // If it's in a terminal "end" state (e.g. disconnectRedis was called
        // and the client was destroyed), fall through to create a new one.
        if (client.status === "ready") return
        if (client.status === "end") {
            // Previous client was explicitly closed; reset so a new one is created.
            client = null
        } else {
            // Still connecting or reconnecting — wait for the next ready or error.
            await new Promise((resolve) => {
                client.once("ready", resolve)
                client.once("error", resolve)  // resolve on error so startup continues
            })
            return
        }
    }

    const url = process.env.REDIS_URL
    if (!url) {
        logger.warn("[redis] REDIS_URL not set — Redis is disabled")
        return
    }

    // Create the client and attach lifecycle handlers BEFORE waiting for
    // the initial connection, so they fire during all future reconnects.
    client = new Redis(url, {
        maxRetriesPerRequest: null,  // required by BullMQ
        enableReadyCheck: true,
        retryStrategy(times) {
            // Retry indefinitely with a delay capped at 2 s.
            // Returning null would permanently stop retries — we never do that,
            // so the client keeps trying until disconnectRedis() is called.
            return Math.min(times * 200, 2000)
        }
    })

    // Register persistent event handlers before awaiting ready.
    // These remain active for the lifetime of the client, including reconnects.
    client.on("ready", () => {
        redisReady.connected = true
        logger.info("[redis] Connected")

        // Install the Redis-backed rate-limit store now that a connection exists.
        // Safe to call multiple times — it replaces the store in place.
        try {
            const { resetLimiters } = require("../middleware/rate-limit.middleware")
            resetLimiters()
        } catch (err) {
            logger.warn("[redis] resetLimiters failed after reconnect", { error: err.message })
        }
    })

    client.on("error", (err) => {
        redisReady.connected = false
        logger.error("[redis] Error", { error: err.message })
    })

    client.on("close", () => {
        redisReady.connected = false
        logger.warn("[redis] Connection closed")
    })

    client.on("reconnecting", () => {
        logger.info("[redis] Reconnecting...")
    })

    // Wait for the first ready or error to unblock startup.
    // On error we log and resolve — the client keeps retrying in the background.
    await new Promise((resolve) => {
        client.once("ready", resolve)
        client.once("error", () => {
            logger.warn("[redis] Initial connection failed — retrying in background")
            resolve()  // don't block server startup
        })
    })
}

/**
 * Closes the Redis connection.
 * Used during graceful shutdown.
 *
 * @returns {Promise<void>}
 */
async function disconnectRedis() {
    if (!client) return
    try {
        await client.quit()
    } catch {
        client.disconnect()
    }
    client = null
    redisReady.connected = false
    logger.info("[redis] Disconnected")
}

module.exports = {
    connectRedis,
    disconnectRedis,
    getRedisClient,
    redisReady
}

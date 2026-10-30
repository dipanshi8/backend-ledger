/**
 * Rate-limiting middleware — Stage 4 Part A
 *
 * Uses express-rate-limit with a Redis-backed store (rate-limit-redis) when
 * Redis is connected. Limiters are created ONCE at module scope and reused
 * for every request — never instantiated inside a request handler.
 *
 * SHARED LIMITS: All application instances connected to the same Redis
 * service share rate-limit counters.
 *
 * REDIS FAILURE POLICY (production):
 *   In production (NODE_ENV !== "test"), if Redis is not connected when a
 *   rate-limited request arrives, the middleware returns a sanitized 503
 *   "Service temporarily unavailable" response. This is a fail-closed
 *   policy — the API refuses to serve rate-limited endpoints rather than
 *   silently falling back to per-instance in-memory counters.
 *
 *   The health endpoints (/health/live, /health/ready) and the legacy root
 *   route are NOT rate-limited and remain available even when Redis is down.
 *
 * TEST MODE:
 *   In NODE_ENV=test the limiters skip enforcement entirely (skip returns
 *   true) so the test suite does not require a Redis server.
 *
 * REINITIALIZATION:
 *   At module load time Redis is not yet connected (app.js is required before
 *   connectRedis() is called in server.js). The limiters start with the
 *   default MemoryStore. After server.js calls connectRedis(), it calls
 *   resetLimiters() to re-create the limiters with a RedisStore.
 *
 * @see https://github.com/express-rate-limit/rate-limit-redis
 */
const rateLimit = require("express-rate-limit")
const { RedisStore } = require("rate-limit-redis")

const { getRedisClient } = require("../config/redis")
const { logger } = require("../config/logger")

const isTest = process.env.NODE_ENV === "test"

/**
 * Shared handler that always returns a sanitized JSON 429 response.
 */
function rateLimitHandler(req, res) {
    res.status(429).json({
        message: "Too many requests, please try again later"
    })
}

/**
 * Sanitized 503 response used when Redis is unavailable in production.
 */
function redisUnavailableResponse(res) {
    return res.status(503).json({
        message: "Service temporarily unavailable, please try again later"
    })
}

// ── Limiter option presets ────────────────────────────────────────────────────

const authLimiterOptions = {
    windowMs: 15 * 60 * 1000,   // 15 minutes
    max: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: rateLimitHandler,
    skip: () => isTest,
}

const financialLimiterOptions = {
    windowMs: 60 * 1000,        // 1 minute
    max: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: rateLimitHandler,
    skip: () => isTest,
}

// ── Module-scope limiter instances ───────────────────────────────────────────
// Created once at module load time. At this point Redis is not yet connected
// (the module is loaded via app.js before connectRedis() runs), so these use
// the default MemoryStore. After Redis connects, server.js calls
// resetLimiters() to replace them with Redis-backed instances.

let _authRateLimiter = rateLimit({ ...authLimiterOptions })
let _financialWriteRateLimiter = rateLimit({ ...financialLimiterOptions })

logger.info("[rate-limit] Limiters initialized (MemoryStore — Redis not yet connected)")

// ── Exported middleware (delegates, never creates inside a request) ──────────

/**
 * Auth rate limiter — 10 requests per 15 minutes per IP.
 * Applied to /api/auth/login and /api/auth/register.
 *
 * In production, if Redis is not connected, returns 503 instead of
 * silently using in-memory counters.
 */
const authRateLimiter = (req, res, next) => {
    if (!isTest) {
        const client = getRedisClient()
        if (!client || client.status !== "ready") {
            return redisUnavailableResponse(res)
        }
    }
    return _authRateLimiter(req, res, next)
}

/**
 * Financial write rate limiter — 30 requests per minute per IP.
 * Applied to POST /api/transactions and POST /api/transactions/system/initial-funds.
 *
 * Same fail-closed policy as the auth limiter.
 */
const financialWriteRateLimiter = (req, res, next) => {
    if (!isTest) {
        const client = getRedisClient()
        if (!client || client.status !== "ready") {
            return redisUnavailableResponse(res)
        }
    }
    return _financialWriteRateLimiter(req, res, next)
}

/**
 * Re-create limiter instances with a Redis-backed store.
 * Called from server.js after connectRedis() succeeds.
 */
function resetLimiters() {
    const client = getRedisClient()
    if (!client || client.status !== "ready") {
        logger.warn("[rate-limit] resetLimiters called but Redis not ready — keeping MemoryStore")
        return
    }

    const store = new RedisStore({
        sendCommand: (...args) => client.call(...args)
    })

    _authRateLimiter = rateLimit({ ...authLimiterOptions, store })
    _financialWriteRateLimiter = rateLimit({ ...financialLimiterOptions, store })
    logger.info("[rate-limit] Limiters reinitialized with Redis store")
}

// ── Test-only factory functions ───────────────────────────────────────────────
// These create isolated limiter instances for the api-security tests.
// They use MemoryStore and do not interfere with the production limiters.

function createTestAuthRateLimiter(max = 3, windowMs = 60 * 1000) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        handler: rateLimitHandler,
        skipSuccessfulRequests: false
    })
}

function createTestFinancialWriteRateLimiter(max = 5, windowMs = 60 * 1000) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        handler: rateLimitHandler,
        skipSuccessfulRequests: false
    })
}

module.exports = {
    authRateLimiter,
    financialWriteRateLimiter,
    resetLimiters,
    rateLimitHandler,
    createTestAuthRateLimiter,
    createTestFinancialWriteRateLimiter,
}

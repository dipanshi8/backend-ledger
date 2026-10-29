/**
 * Rate-limiting middleware for Stage 3B API security.
 *
 * Uses express-rate-limit with in-memory storage (MemoryStore).
 *
 * LIMITATION: counters are process-local. In a multi-instance deployment
 * (multiple Node.js processes or containers behind a load balancer) each
 * instance tracks its own window independently, so the effective limit is
 * multiplied by the number of instances. Use a shared external store
 * (e.g. redis-rate-limit or rate-limit-redis) when running at scale.
 *
 * TEST ENVIRONMENT
 * In NODE_ENV=test the limiters skip enforcement (skip always returns true).
 * The api-security.test.js suite creates its own limiter instances with tight
 * limits to test rate-limiting behaviour in isolation without affecting the
 * shared in-memory counters used by other test suites.
 */
const rateLimit = require("express-rate-limit")

const isTest = process.env.NODE_ENV === "test"

/**
 * Shared handler that always returns a sanitized JSON 429 response.
 * Prevents leaking framework internals and matches the project's
 * centralized error-response shape.
 */
function rateLimitHandler(req, res) {
    res.status(429).json({
        message: "Too many requests, please try again later"
    })
}

/**
 * Auth rate limiter — applied to /api/auth/login and /api/auth/register.
 *
 * 10 attempts per 15-minute window per IP.
 * Designed to resist brute-force credential stuffing without blocking
 * legitimate users who occasionally mistype their password.
 */
const authRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    standardHeaders: "draft-7",  // Return RateLimit-* headers (RFC-6585 draft 7)
    legacyHeaders: false,
    handler: rateLimitHandler,
    skipSuccessfulRequests: false,
    // In test mode skip all requests so the shared in-memory counter does not
    // bleed across test suites that share the same module cache.
    skip: () => isTest
})

/**
 * Financial write rate limiter — applied to POST /api/transactions
 * and POST /api/transactions/system/initial-funds.
 *
 * 30 writes per minute per IP.
 * Generous enough for legitimate high-frequency use while deterring
 * automated abuse or enumeration attacks.
 */
const financialWriteRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: rateLimitHandler,
    skipSuccessfulRequests: false,
    // Same reason — skip in test mode.
    skip: () => isTest
})

/**
 * Creates a tight auth rate limiter for use in tests only.
 * Allows tests to verify rate-limiting behaviour with a small window
 * without sharing state with the production limiters.
 *
 * @param {number} max   Maximum requests per window (default 3)
 * @param {number} windowMs  Window in ms (default 60000)
 */
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

/**
 * Creates a tight financial write rate limiter for use in tests only.
 */
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
    createTestAuthRateLimiter,
    createTestFinancialWriteRateLimiter,
    rateLimitHandler
}


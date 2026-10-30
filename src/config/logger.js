/**
 * Lightweight structured logger — Stage 3C
 *
 * Uses only Node.js built-ins (JSON.stringify + console).
 * No additional dependencies are introduced.
 *
 * Log levels: error > warn > info > http > debug
 *
 * Output format: newline-delimited JSON (NDJSON)
 *   {"level":"info","ts":"2026-10-29T10:00:00.000Z","msg":"Server started","port":3000}
 *
 * Security rules enforced here:
 *  - Authorization, Cookie, and Set-Cookie request headers are redacted.
 *  - The "password" field in request bodies is never logged.
 *  - JWT tokens, email credentials, and financial payload amounts are not
 *    included in access-log entries.
 */

const LEVELS = { error: 0, warn: 1, info: 2, http: 3, debug: 4 }

// Default to 'info' in production, 'debug' in development.
// In test mode use 'error' to keep test output clean.
function resolveLevel() {
    const env = process.env.NODE_ENV || "development"
    if (env === "test") return "error"
    if (env === "production") return "info"
    return "debug"
}

let currentLevel = resolveLevel()

function shouldLog(level) {
    return (LEVELS[level] ?? 0) <= (LEVELS[currentLevel] ?? 99)
}

function write(level, msg, meta = {}) {
    if (!shouldLog(level)) return
    const entry = {
        level,
        ts: new Date().toISOString(),
        msg,
        ...meta
    }
    // Errors go to stderr, everything else to stdout
    if (level === "error") {
        console.error(JSON.stringify(entry))
    } else {
        console.log(JSON.stringify(entry))
    }
}

const logger = {
    error: (msg, meta) => write("error", msg, meta),
    warn:  (msg, meta) => write("warn",  msg, meta),
    info:  (msg, meta) => write("info",  msg, meta),
    http:  (msg, meta) => write("http",  msg, meta),
    debug: (msg, meta) => write("debug", msg, meta),

    /** Allow tests or the server entry point to lower/raise the log level. */
    setLevel(level) {
        if (LEVELS[level] === undefined) {
            throw new Error(`Unknown log level: ${level}`)
        }
        currentLevel = level
    }
}

/**
 * Express middleware that logs one HTTP access-log entry per request.
 * Redacts sensitive headers and never logs request bodies.
 *
 * @returns {import('express').RequestHandler}
 */
function requestLogger() {
    return (req, res, next) => {
        const start = Date.now()

        res.on("finish", () => {
            logger.http("request", {
                method: req.method,
                url: req.originalUrl || req.url,
                status: res.statusCode,
                ms: Date.now() - start,
                ip: req.ip || req.connection?.remoteAddress || "unknown"
            })
        })

        next()
    }
}

module.exports = { logger, requestLogger }

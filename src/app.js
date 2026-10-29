/**
 * Express application — Stage 3B/3C
 *
 * Middleware order (must not be changed without understanding dependencies):
 *   1. helmet          — security headers on every response
 *   2. cors            — CORS preflight + credentialed-origin enforcement
 *   3. requestLogger   — structured HTTP access log (redacts sensitive headers)
 *   4. express.json    — body parsing with explicit size cap
 *   5. cookieParser    — cookie access for auth middleware
 *   6. rate limiters   — mounted on individual routers (see routes)
 *   7. routes          — API routes
 *   8. 404 fallback
 *   9. centralized error handler
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CORS CONFIGURATION
 * ─────────────────────────────────────────────────────────────────────────────
 * Set ALLOWED_ORIGINS as a comma-separated list of full origins in your
 * environment.  An "origin" is scheme + host + port, e.g.:
 *
 *   Local development:
 *     ALLOWED_ORIGINS=http://localhost:3001
 *
 *   Multiple origins:
 *     ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
 *
 * If ALLOWED_ORIGINS is absent or empty:
 *   - In NODE_ENV=test  — all origins are allowed (integration-test convenience)
 *   - In all other envs — no origin is permitted (safe closed default)
 *
 * Wildcard origins ('*') are never combined with credentials=true to comply
 * with the CORS specification and browser security requirements.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RATE LIMITING
 * ─────────────────────────────────────────────────────────────────────────────
 * In-memory counters — NOT shared across multiple application instances.
 * See src/middleware/rate-limit.middleware.js for limits and notes on
 * upgrading to a shared store for multi-instance deployments.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HEALTH ENDPOINTS
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /health/live   — liveness: returns 200 if the process is running
 * GET /health/ready  — readiness: returns 200 only when MongoDB is connected;
 *                      returns 503 during startup or after a disconnect
 */

const express = require("express")
const helmet = require("helmet")
const cors = require("cors")
const cookieParser = require("cookie-parser")
const { errorHandler } = require("./middleware/error.middleware")
const { requestLogger } = require("./config/logger")
const { readinessState } = require("./config/db")

// ── CORS origin list ──────────────────────────────────────────────────────────
/**
 * Parse ALLOWED_ORIGINS env var into a validated list.
 * Each entry must look like a full origin (scheme://host[:port]).
 * Entries that do not match the pattern are dropped with a warning.
 */
function parseAllowedOrigins() {
    const raw = process.env.ALLOWED_ORIGINS || ""
    if (!raw.trim()) return []

    return raw
        .split(",")
        .map(o => o.trim())
        .filter(o => {
            if (!o) return false
            try {
                const url = new URL(o)
                const isValid =
                    (url.protocol === "http:" || url.protocol === "https:") &&
                    url.hostname.length > 0 &&
                    url.pathname === "/" &&
                    !url.search &&
                    !url.hash
                if (!isValid) {
                    console.warn(`[CORS] Ignoring invalid origin entry: "${o}"`)
                }
                return isValid
            } catch {
                console.warn(`[CORS] Ignoring unparseable origin entry: "${o}"`)
                return false
            }
        })
        .map(o => o.replace(/\/$/, ""))
}

const allowedOrigins = parseAllowedOrigins()

const corsOptions = {
    origin(requestOrigin, callback) {
        if (!requestOrigin) {
            return callback(null, true)
        }
        if (process.env.NODE_ENV === "test" && allowedOrigins.length === 0) {
            return callback(null, true)
        }
        if (allowedOrigins.includes(requestOrigin)) {
            return callback(null, requestOrigin)
        }
        return callback(new Error(`CORS: origin not allowed: ${requestOrigin}`))
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express()

// 1. Security headers
app.use(helmet())

// 2. CORS (before route handlers so preflight OPTIONS is handled correctly)
app.use(cors(corsOptions))

// 3. Structured HTTP access log (redacts Authorization and Cookie headers)
app.use(requestLogger())

// 4. Body parsing — 100 kB cap; oversized bodies return a controlled 413
app.use(express.json({ limit: "100kb" }))

// 5. Cookie parsing
app.use(cookieParser())

// ── Health endpoints (unauthenticated, no rate limiting) ─────────────────────
/**
 * GET /health/live
 * Liveness probe — returns 200 as long as the Node.js process is alive.
 * Does not check external dependencies.
 */
app.get("/health/live", (req, res) => {
    res.status(200).json({ status: "ok" })
})

/**
 * GET /health/ready
 * Readiness probe — returns 200 only when the application can serve requests
 * (MongoDB is connected). Returns 503 during startup or after a disconnect.
 * Does not expose connection strings, credentials, or internal error details.
 */
app.get("/health/ready", (req, res) => {
    if (readinessState.dbReady) {
        return res.status(200).json({ status: "ready" })
    }
    return res.status(503).json({ status: "unavailable", reason: "database not connected" })
})

// ── Legacy root liveness (kept for backwards compatibility) ───────────────────
app.get("/", (req, res) => {
    res.send("Ledger Service is up and running")
})

// ── API routes ────────────────────────────────────────────────────────────────
const authRouter = require("./routes/auth.routes")
const accountRouter = require("./routes/account.routes")
const transactionRoutes = require("./routes/transaction.routes")

app.use("/api/auth", authRouter)
app.use("/api/accounts", accountRouter)
app.use("/api/transactions", transactionRoutes)

// Fallback for unmatched routes
app.use((req, res) => {
    res.status(404).json({ message: "Route not found" })
})

// Centralized error handler (must be last)
app.use(errorHandler)

module.exports = app

/**
 * Express application — middleware order:
 *   1. helmet       — security headers
 *   2. cors         — CORS with credentialed-origin enforcement
 *   3. requestLogger — structured access log (redacts auth headers)
 *   4. express.json — body parsing, 100 kB limit
 *   5. cookieParser
 *   6. rate limiters — mounted on individual routers (see routes/)
 *   7. routes
 *   8. 404 fallback
 *   9. centralized error handler
 *
 * CORS: set ALLOWED_ORIGINS to a comma-separated list of allowed browser
 * origins (e.g. http://localhost:3001). In test mode with no configured
 * origins, all origins are permitted. In other modes, an empty list denies
 * all cross-origin requests. Wildcard + credentials is never used.
 *
 * Rate limiting: uses Redis-backed store when Redis is connected.
 * Falls back to fail-closed 503 when Redis is unavailable (production).
 * See src/middleware/rate-limit.middleware.js for policy details.
 *
 * Health endpoints (unauthenticated, no rate limiting):
 *   GET /health/live  — process is alive
 *   GET /health/ready — MongoDB connected; includes Redis status
 */

const express = require("express")
const helmet = require("helmet")
const cors = require("cors")
const cookieParser = require("cookie-parser")
const { errorHandler } = require("./middleware/error.middleware")
const { requestLogger } = require("./config/logger")
const { readinessState } = require("./config/db")
const { redisReady } = require("./config/redis")

// ── CORS origin list ──────────────────────────────────────────────────────────
// Parse ALLOWED_ORIGINS into a validated list of full origins (scheme://host[:port]).
// Malformed entries are dropped with a warning.
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

app.get("/health/live", (req, res) => {
    res.status(200).json({ status: "ok" })
})

app.get("/health/ready", (req, res) => {
    if (readinessState.dbReady) {
        return res.status(200).json({
            status: "ready",
            redis: redisReady.connected ? "connected" : "disconnected"
        })
    }
    return res.status(503).json({
        status: "unavailable",
        reason: "database not connected"
    })
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

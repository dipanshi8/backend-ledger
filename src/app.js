/**
 * Express application — Stage 3B: API Security & Protection
 *
 * Middleware order (must not be changed without understanding dependencies):
 *   1. helmet          — security headers on every response
 *   2. cors            — CORS preflight + credentialed-origin enforcement
 *   3. express.json    — body parsing with explicit size cap
 *   4. cookieParser    — cookie access for auth middleware
 *   5. rate limiters   — mounted on individual routers (see routes)
 *   6. routes
 *   7. 404 fallback
 *   8. centralized error handler
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
 */

const express = require('express')
const helmet = require('helmet')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const { errorHandler } = require('./middleware/error.middleware')

// ── CORS origin list ──────────────────────────────────────────────────────────
/**
 * Parse ALLOWED_ORIGINS env var into a validated list.
 * Each entry must look like a full origin (scheme://host[:port]).
 * Entries that do not match the pattern are silently dropped and warned.
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
                // Must have an explicit scheme and host; no path/query/fragment.
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
        .map(o => {
            // Normalize: strip trailing slash that new URL() added.
            return o.replace(/\/$/, "")
        })
}

const allowedOrigins = parseAllowedOrigins()

const corsOptions = {
    /**
     * Dynamic origin check — avoids the insecure wildcard+credentials combo.
     * In test mode with no configured origins we allow everything so that
     * supertest requests (which have no Origin header) pass through cleanly.
     */
    origin(requestOrigin, callback) {
        // Requests with no Origin header (same-origin browser requests, curl,
        // supertest, server-to-server) are always allowed.
        if (!requestOrigin) {
            return callback(null, true)
        }

        // Test environment with no configured origins: allow all.
        if (process.env.NODE_ENV === "test" && allowedOrigins.length === 0) {
            return callback(null, true)
        }

        if (allowedOrigins.includes(requestOrigin)) {
            return callback(null, requestOrigin)
        }

        return callback(new Error(`CORS: origin not allowed: ${requestOrigin}`))
    },
    credentials: true,   // Required for cookie-based auth flows
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express()

// 1. Security headers
app.use(helmet())

// 2. CORS (must be before any route handler so preflight OPTIONS are handled)
app.use(cors(corsOptions))

// 3. Body parsing — 100 kB cap; oversized bodies return a controlled 413 via
//    the centralized error handler.
app.use(express.json({ limit: "100kb" }))

// 4. Cookie parsing
app.use(cookieParser())

// ── Routes ────────────────────────────────────────────────────────────────────
const authRouter = require('./routes/auth.routes')
const accountRouter = require('./routes/account.routes')
const transactionRoutes = require('./routes/transaction.routes')

app.get("/", (req, res) => {
    res.send("Ledger Service is up and running")
})

app.use("/api/auth", authRouter)
app.use("/api/accounts", accountRouter)
app.use('/api/transactions', transactionRoutes)

// Fallback for unmatched routes
app.use((req, res) => {
    res.status(404).json({ message: "Route not found" })
})

// Centralized error handler (must be last)
app.use(errorHandler)

module.exports = app

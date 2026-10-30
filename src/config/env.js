/**
 * Environment validation — Stage 3C
 *
 * Validates all environment variables genuinely required by the application.
 * Called once at process startup before the database connection is opened.
 *
 * Rules:
 *  - Fails fast with a clear, actionable message if a required variable is absent.
 *  - Validates formats where practical (PORT, NODE_ENV, MONGO_URI prefix).
 *  - Never prints secret values; only key names are reported.
 */

const REQUIRED_VARS = [
    "MONGO_URI",
    "JWT_SECRET"
]

// REDIS_URL is required in production/development but optional in test mode.
// In test mode, rate limiters skip enforcement and the outbox dispatcher is
// not started, so Redis is not needed.
const REQUIRED_VARS_NON_TEST = [
    ...REQUIRED_VARS,
    "REDIS_URL"
]

const VALID_NODE_ENVS = ["development", "production", "test"]

/**
 * Validates all required environment variables.
 * Throws an error with a descriptive message on the first failure.
 * Must be called before any module that uses process.env at runtime.
 */
function validateEnv() {
    const isTest = process.env.NODE_ENV === "test"
    const vars = isTest ? REQUIRED_VARS : REQUIRED_VARS_NON_TEST

    const missing = vars.filter(key => !process.env[key] || !process.env[key].trim())

    if (missing.length > 0) {
        throw new Error(
            `[env] Missing required environment variable(s): ${missing.join(", ")}.\n` +
            `Copy .env.example to .env and fill in the values.`
        )
    }

    // PORT: must be a valid integer in the 1–65535 range if provided
    if (process.env.PORT !== undefined) {
        const port = Number(process.env.PORT)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(
                `[env] PORT must be an integer between 1 and 65535, got: "${process.env.PORT}"`
            )
        }
    }

    // NODE_ENV: warn on non-standard values; do not fail (some tooling uses custom names)
    if (process.env.NODE_ENV && !VALID_NODE_ENVS.includes(process.env.NODE_ENV)) {
        console.warn(
            `[env] Unrecognised NODE_ENV "${process.env.NODE_ENV}". ` +
            `Expected one of: ${VALID_NODE_ENVS.join(", ")}.`
        )
    }

    // MONGO_URI: must look like a MongoDB connection string
    const mongoUri = process.env.MONGO_URI
    if (!mongoUri.startsWith("mongodb://") && !mongoUri.startsWith("mongodb+srv://")) {
        throw new Error(
            `[env] MONGO_URI must start with "mongodb://" or "mongodb+srv://". ` +
            `Check the value in your .env file.`
        )
    }
}

module.exports = { validateEnv }

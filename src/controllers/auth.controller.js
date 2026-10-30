const userModel = require("../models/user.model")
const jwt = require("jsonwebtoken")
const notificationOutboxModel = require("../models/notification-outbox.model")
const tokenBlackListModel = require("../models/blackList.model")

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 3 * 24 * 60 * 60 * 1000 // 3 days
}

/**
 * Validates registration input fields.
 * Rejects missing fields, non-strings, NoSQL query objects, and out-of-bound lengths.
 * @param {any} body
 * @returns {{ isValid: boolean, error?: string, normalizedEmail?: string, name?: string }}
 */
function validateRegistrationInput(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { isValid: false, error: "Request body must be a JSON object" }
    }

    const { email, password, name } = body

    if (typeof email !== "string" || !email.trim() || email.length > 254 || !EMAIL_REGEX.test(email.trim())) {
        return { isValid: false, error: "Invalid email format" }
    }

    if (typeof password !== "string" || password.length < 6 || password.length > 128) {
        return { isValid: false, error: "Password must be between 6 and 128 characters long" }
    }

    if (typeof name !== "string" || !name.trim() || name.trim().length > 100) {
        return { isValid: false, error: "Name is required and must not exceed 100 characters" }
    }

    return {
        isValid: true,
        normalizedEmail: email.trim().toLowerCase(),
        name: name.trim()
    }
}

/**
 * Validates login input types.
 * Rejects non-strings, objects (NoSQL injection payloads), and missing values.
 * @param {any} body
 * @returns {{ isValid: boolean, error?: string, normalizedEmail?: string }}
 */
function validateLoginInput(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { isValid: false, error: "Request body must be a JSON object" }
    }

    const { email, password } = body

    if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
        return { isValid: false, error: "Email and password are required and must be valid strings" }
    }

    return {
        isValid: true,
        normalizedEmail: email.trim().toLowerCase()
    }
}

/**
 * User register controller
 * POST /api/auth/register
 */
async function userRegisterController(req, res) {
    const validation = validateRegistrationInput(req.body)
    if (!validation.isValid) {
        return res.status(400).json({
            message: validation.error
        })
    }

    const { normalizedEmail, name } = validation
    const { password } = req.body

    const isExists = await userModel.findOne({
        email: normalizedEmail
    })

    if (isExists) {
        return res.status(422).json({
            message: "User already exists with email.",
            status: "failed"
        })
    }

    const user = await userModel.create({
        email: normalizedEmail,
        password,
        name
    })

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "3d" })

    res.cookie("token", token, COOKIE_OPTIONS)

    res.status(201).json({
        user: {
            _id: user._id,
            email: user.email,
            name: user.name
        },
        token
    })

    // Create notification outbox event for the welcome email.
    // Registration is not inside a MongoDB transaction, so this is best-effort
    // (same risk profile as the previous fire-and-forget approach).
    // The outbox dispatcher will pick this up and enqueue to BullMQ.
    notificationOutboxModel.create({
        entityId: user._id,
        entityType: "user",
        type: "registration",
        to: user.email,
        name: user.name,
        context: {}
    }).catch(() => {})
}

/**
 * User Login Controller
 * POST /api/auth/login
 */
async function userLoginController(req, res) {
    const validation = validateLoginInput(req.body)
    if (!validation.isValid) {
        return res.status(400).json({
            message: validation.error
        })
    }

    const { normalizedEmail } = validation
    const { password } = req.body

    const user = await userModel.findOne({ email: normalizedEmail }).select("+password")

    if (!user) {
        return res.status(401).json({
            message: "Email or password is INVALID"
        })
    }

    const isValidPassword = await user.comparePassword(password)

    if (!isValidPassword) {
        return res.status(401).json({
            message: "Email or password is INVALID"
        })
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "3d" })

    res.cookie("token", token, COOKIE_OPTIONS)

    res.status(200).json({
        user: {
            _id: user._id,
            email: user.email,
            name: user.name
        },
        token
    })
}

/**
 * User Logout Controller
 * POST /api/auth/logout
 */
async function userLogoutController(req, res) {
    const token = req.cookies.token || req.headers.authorization?.split(" ")[ 1 ]

    if (!token) {
        return res.status(200).json({
            message: "User logged out successfully"
        })
    }

    await tokenBlackListModel.create({
        token: token
    })

    res.clearCookie("token", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax"
    })

    res.status(200).json({
        message: "User logged out successfully"
    })
}

module.exports = {
    userRegisterController,
    userLoginController,
    userLogoutController
}

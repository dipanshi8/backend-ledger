const express = require("express")
const authController = require("../controllers/auth.controller")
const { authRateLimiter } = require("../middleware/rate-limit.middleware")

const router = express.Router()

/**
 * Rate limiter is applied here, directly on the auth router, so it cannot
 * be bypassed by middleware-ordering mistakes in app.js.
 */

/* POST /api/auth/register */
router.post("/register", authRateLimiter, authController.userRegisterController)

/* POST /api/auth/login */
router.post("/login", authRateLimiter, authController.userLoginController)

/* POST /api/auth/logout */
router.post("/logout", authController.userLogoutController)

module.exports = router

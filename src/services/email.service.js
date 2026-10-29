/**
 * Email notification service — Stage 3C minimal improvement
 *
 * Key change from the original:
 *   transporter.verify() was called immediately on module load, which fired a
 *   live SMTP connection attempt every time tests required this file (even when
 *   mocked) and printed noise to the console.  It is now deferred to
 *   verifyEmailConnection(), called only from the production server entry point.
 *
 * Financial safety note:
 *   Email delivery is best-effort and intentionally decoupled from financial
 *   operations.  A committed transaction is complete regardless of whether the
 *   notification email is delivered.  Controllers call email functions with
 *   .catch(() => {}) so a failed notification never rolls back a transaction or
 *   changes the HTTP response code returned to the client.
 */

const nodemailer = require("nodemailer")
const { logger } = require("../config/logger")

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        type: "OAuth2",
        user: process.env.EMAIL_USER,
        clientId: process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET,
        refreshToken: process.env.REFRESH_TOKEN
    }
})

/**
 * Checks the SMTP connection.  Called once at server startup (not on require).
 * Logs a warning if the connection cannot be established but does not abort
 * startup — the application is functional without email delivery.
 */
async function verifyEmailConnection() {
    try {
        await transporter.verify()
        logger.info("[email] SMTP connection verified")
    } catch (err) {
        logger.warn("[email] SMTP connection failed — email notifications will not be sent", {
            error: err.message
        })
    }
}

/**
 * Internal send helper.  All errors are caught and logged; they must never
 * propagate to callers that have already committed a financial transaction.
 */
async function sendEmail(to, subject, text, html) {
    try {
        const info = await transporter.sendMail({
            from: `"Backend Ledger" <${process.env.EMAIL_USER}>`,
            to,
            subject,
            text,
            html
        })
        logger.info("[email] Message sent", { messageId: info.messageId })
    } catch (err) {
        logger.error("[email] Failed to send email", { error: err.message })
    }
}

async function sendRegistrationEmail(userEmail, name) {
    const subject = "Welcome to Backend Ledger!"
    const text = `Hello ${name},\n\nThank you for registering at Backend Ledger. We're excited to have you on board!\n\nBest regards,\nThe Backend Ledger Team`
    const html = `<p>Hello ${name},</p><p>Thank you for registering at Backend Ledger. We're excited to have you on board!</p><p>Best regards,<br>The Backend Ledger Team</p>`
    await sendEmail(userEmail, subject, text, html)
}

async function sendTransactionEmail(userEmail, name, amount, toAccount) {
    const subject = "Transaction Successful!"
    const text = `Hello ${name},\n\nYour transaction of ₹${amount} to account ${toAccount} was successful.\n\nBest regards,\nThe Backend Ledger Team`
    const html = `<p>Hello ${name},</p><p>Your transaction of ₹${amount} to account ${toAccount} was successful.</p><p>Best regards,<br>The Backend Ledger Team</p>`
    await sendEmail(userEmail, subject, text, html)
}

async function sendTransactionFailureEmail(userEmail, name, amount, toAccount) {
    const subject = "Transaction Failed"
    const text = `Hello ${name},\n\nWe regret to inform you that your transaction of ₹${amount} to account ${toAccount} has failed. Please try again later.\n\nBest regards,\nThe Backend Ledger Team`
    const html = `<p>Hello ${name},</p><p>We regret to inform you that your transaction of ₹${amount} to account ${toAccount} has failed. Please try again later.</p><p>Best regards,<br>The Backend Ledger Team</p>`
    await sendEmail(userEmail, subject, text, html)
}

module.exports = {
    verifyEmailConnection,
    sendRegistrationEmail,
    sendTransactionEmail,
    sendTransactionFailureEmail
}

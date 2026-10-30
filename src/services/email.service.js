/**
 * Email notification service
 *
 * sendEmail() propagates errors so the BullMQ processor can trigger retries.
 * The transporter is created at module load time; verifyEmailConnection() is
 * called once at server startup and logs a warning if SMTP is unreachable,
 * but does not abort startup — email delivery is optional.
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
 * Sends an email via nodemailer. Throws on failure so BullMQ can retry.
 * Do not call this directly from request handlers — use the outbox.
 */
async function sendEmail(to, subject, text, html) {
    const info = await transporter.sendMail({
        from: `"Backend Ledger" <${process.env.EMAIL_USER}>`,
        to,
        subject,
        text,
        html
    })
    logger.info("[email] Message sent", { messageId: info.messageId })
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

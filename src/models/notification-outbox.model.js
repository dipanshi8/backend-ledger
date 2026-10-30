/**
 * Notification outbox model — transactional outbox pattern
 *
 * For each successful financial transfer, one outbox event is created inside
 * the same MongoDB session as the transaction and ledger entries. If the
 * session commits, the event is durable. If the session rolls back, the event
 * disappears — no orphan notifications.
 *
 * For registration emails the event is created outside a transaction
 * (best-effort), which has the same risk profile as the previous
 * fire-and-forget approach.
 *
 * Outbox states:
 *   PENDING      — created, waiting for the dispatcher to claim it
 *   DISPATCHING  — atomically claimed by the dispatcher; reverts to PENDING
 *                  if the process crashes before marking DISPATCHED, or if
 *                  the BullMQ enqueue fails
 *   DISPATCHED   — job successfully submitted to BullMQ
 *   SENT         — reserved for future use
 *   FAILED       — exceeded MAX_DISPATCH_ATTEMPTS; retained for review
 *
 * Failed events are not deleted automatically. They are retained for manual
 * inspection and potential reprocessing.
 */

const mongoose = require("mongoose")

const notificationOutboxSchema = new mongoose.Schema({
    /**
     * The entity this notification is tied to.
     * For transaction emails: the transaction document.
     * For registration emails: the user document.
     */
    entityId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },

    /**
     * Entity type — determines correlation and traceability.
     */
    entityType: {
        type: String,
        required: true,
        enum: ["transaction", "user"]
    },

    /**
     * Email type — determines which template the processor uses.
     * "transaction" | "registration"
     */
    type: {
        type: String,
        required: true,
        enum: ["transaction", "registration"]
    },

    /**
     * Recipient email address.
     */
    to: {
        type: String,
        required: true
    },

    /**
     * Recipient name (for the email template).
     */
    name: {
        type: String,
        required: true
    },

    /**
     * Additional context for the email template.
     * For transaction emails: { amount, toAccount }
     * Kept minimal — no sensitive financial payload beyond what the template needs.
     */
    context: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },

    /**
     * Outbox event state:
     *   PENDING      — waiting for dispatch
     *   DISPATCHING  — claimed by a dispatcher (atomic claim); reverts to
     *                  PENDING if the claim expires or enqueue fails
     *   DISPATCHED   — submitted to BullMQ successfully
     *   SENT         — email confirmed sent (reserved for future use)
     *   FAILED       — exhausted retries, retained for review
     */
    status: {
        type: String,
        required: true,
        enum: ["PENDING", "DISPATCHING", "DISPATCHED", "SENT", "FAILED"],
        default: "PENDING",
        index: true
    },

    /**
     * Timestamp of the last atomic claim (status set to DISPATCHING).
     * Used to detect stale claims after a crash and revert them to PENDING.
     */
    claimedAt: {
        type: Date,
        default: null
    },

    /**
     * Number of dispatch attempts (separate from BullMQ's own retry count).
     * Incremented each time the dispatcher tries to enqueue this event.
     */
    dispatchAttempts: {
        type: Number,
        default: 0
    },

    /**
     * BullMQ job ID assigned when the event is dispatched.
     * Used for correlation and idempotency.
     */
    jobId: {
        type: String,
        default: null
    },

    /**
     * Last error message from dispatch or processing.
     */
    lastError: {
        type: String,
        default: null
    }

}, {
    timestamps: true
})

// Compound index for efficient dispatcher polling
notificationOutboxSchema.index({ status: 1, createdAt: 1 })

const notificationOutboxModel = mongoose.model("notificationOutbox", notificationOutboxSchema)

module.exports = notificationOutboxModel

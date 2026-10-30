/**
 * Outbox dispatcher — Stage 4 Part C
 *
 * A recoverable dispatcher that polls the notification outbox for PENDING
 * events and submits them to BullMQ.
 *
 * ATOMIC CLAIM FLOW (per event):
 *   1. Atomically transition status PENDING → DISPATCHING and set claimedAt
 *      (findOneAndUpdate with status: "PENDING" condition — only one
 *      dispatcher can succeed)
 *   2. Try to enqueue a BullMQ job with deterministic ID
 *   3. If enqueue succeeds: transition DISPATCHING → DISPATCHED, set jobId
 *   4. If enqueue fails: revert DISPATCHING → PENDING, clear claimedAt
 *   5. If dispatchAttempts exceeds MAX_DISPATCH_ATTEMPTS: mark as FAILED
 *
 * CRASH RECOVERY:
 *   If the process crashes while an event is in DISPATCHING state, the event
 *   stays DISPATCHING. On restart, recoverPendingEvents() reverts any event
 *   that has been in DISPATCHING longer than LEASE_TIMEOUT_MS back to PENDING.
 *   The next poll cycle then picks it up. Because BullMQ uses deterministic
 *   job IDs, if the crash happened after enqueue but before the DISPATCHED
 *   update, re-enqueuing is idempotent — BullMQ returns the existing job.
 *
 * MAX_DISPATCH_ATTEMPTS:
 *   After 5 failed dispatch attempts, the event is marked FAILED (not deleted).
 *   Failed events are retained for manual review and potential reprocessing.
 *
 * POLLING:
 *   Uses setInterval with an isPolling guard to prevent overlapping polls.
 *   The dispatcher runs only in the API server process — the worker does not
 *   run a dispatcher to avoid duplicate dispatch loops.
 */

const notificationOutboxModel = require("../models/notification-outbox.model")
const emailQueue = require("../queues/email.queue")
const { logger } = require("../config/logger")

const MAX_DISPATCH_ATTEMPTS = 5
const DEFAULT_POLL_INTERVAL_MS = 10_000 // 10 seconds
const BATCH_SIZE = 50
const LEASE_TIMEOUT_MS = 60_000 // stale claim after 60 seconds

let pollInterval = null
let isPolling = false
let isStarted = false

/**
 * Dispatches a single outbox event to BullMQ.
 *
 * Uses an atomic PENDING → DISPATCHING claim so concurrent dispatchers
 * cannot process the same event.
 *
 * @param {object} event — The outbox event document (must have status PENDING)
 * @returns {Promise<boolean>} true if dispatched successfully
 */
async function dispatchEvent(event) {
    // Atomic claim: PENDING → DISPATCHING + increment attempts + set claimedAt
    const claimed = await notificationOutboxModel.findOneAndUpdate(
        { _id: event._id, status: "PENDING" },
        {
            $set: { status: "DISPATCHING", claimedAt: new Date() },
            $inc: { dispatchAttempts: 1 }
        },
        { returnDocument: "after" }
    )

    if (!claimed) {
        // Another dispatcher already claimed it, or it's no longer PENDING
        return false
    }

    // Check attempt limit
    if (claimed.dispatchAttempts > MAX_DISPATCH_ATTEMPTS) {
        await notificationOutboxModel.updateOne(
            { _id: event._id, status: "DISPATCHING" },
            { status: "FAILED", lastError: "Exceeded max dispatch attempts", claimedAt: null }
        )
        logger.warn("[outbox-dispatcher] Event marked as FAILED", {
            eventId: event._id,
            attempts: claimed.dispatchAttempts
        })
        return false
    }

    // Try to enqueue to BullMQ with deterministic job ID
    const result = await emailQueue.enqueueEmailJob({
        outboxEventId: String(event._id),
        type: event.type,
        to: event.to,
        name: event.name,
        context: event.context || {}
    })

    if (result) {
        // Enqueue succeeded — mark as DISPATCHED
        await notificationOutboxModel.updateOne(
            { _id: event._id, status: "DISPATCHING" },
            { status: "DISPATCHED", jobId: result.jobId, claimedAt: null }
        )
        logger.info("[outbox-dispatcher] Event dispatched", {
            eventId: event._id,
            jobId: result.jobId
        })
        return true
    }

    // Enqueue failed — revert to PENDING so the next poll can retry
    await notificationOutboxModel.updateOne(
        { _id: event._id, status: "DISPATCHING" },
        {
            status: "PENDING",
            claimedAt: null,
            lastError: "Queue submission failed"
        }
    )
    logger.warn("[outbox-dispatcher] Enqueue failed, event reverted to PENDING", {
        eventId: event._id,
        attempts: claimed.dispatchAttempts
    })
    return false
}

/**
 * Polls for PENDING outbox events and dispatches them.
 */
async function pollOnce() {
    if (isPolling) return
    isPolling = true

    try {
        const events = await notificationOutboxModel
            .find({ status: "PENDING" })
            .sort({ createdAt: 1 })
            .limit(BATCH_SIZE)

        if (events.length === 0) return

        logger.debug("[outbox-dispatcher] Found pending events", { count: events.length })

        for (const event of events) {
            try {
                await dispatchEvent(event)
            } catch (err) {
                logger.error("[outbox-dispatcher] Error dispatching event", {
                    eventId: event._id,
                    error: err.message
                })
                // Continue with next event — one failure shouldn't block others
            }
        }
    } catch (err) {
        logger.error("[outbox-dispatcher] Poll error", { error: err.message })
    } finally {
        isPolling = false
    }
}

/**
 * Starts the dispatcher polling loop.
 * Call this from the API server after Redis and MongoDB are connected.
 *
 * @param {number} [intervalMs] — Polling interval in milliseconds
 */
function startDispatcher(intervalMs = DEFAULT_POLL_INTERVAL_MS) {
    if (isStarted) {
        logger.warn("[outbox-dispatcher] Already started, ignoring duplicate start")
        return
    }
    isStarted = true

    // Run one poll immediately
    pollOnce().catch(() => {})

    pollInterval = setInterval(() => {
        pollOnce().catch(() => {})
    }, intervalMs)

    // Don't keep the process alive just for the poll
    if (pollInterval.unref) {
        pollInterval.unref()
    }

    logger.info("[outbox-dispatcher] Started", { intervalMs })
}

/**
 * Stops the dispatcher polling loop.
 */
function stopDispatcher() {
    if (pollInterval) {
        clearInterval(pollInterval)
        pollInterval = null
    }
    isStarted = false
    logger.info("[outbox-dispatcher] Stopped")
}

/**
 * Recover PENDING and stale DISPATCHING events — called on startup before
 * the first poll.
 *
 * Reverts any event stuck in DISPATCHING longer than LEASE_TIMEOUT_MS back to
 * PENDING so the next poll can retry it. This handles the crash window
 * between atomic claim and enqueue/ DISPATCHED update.
 */
async function recoverPendingEvents() {
    const leaseExpiry = new Date(Date.now() - LEASE_TIMEOUT_MS)

    // Revert stale DISPATCHING claims
    const staleResult = await notificationOutboxModel.updateMany(
        { status: "DISPATCHING", claimedAt: { $lt: leaseExpiry } },
        { status: "PENDING", claimedAt: null }
    )

    const pendingCount = await notificationOutboxModel.countDocuments({ status: "PENDING" })

    if (pendingCount > 0 || (staleResult && staleResult.modified > 0)) {
        logger.info("[outbox-dispatcher] Recovery check", {
            pending: pendingCount,
            staleReverted: staleResult ? staleResult.modified : 0
        })
    }
}

module.exports = {
    startDispatcher,
    stopDispatcher,
    recoverPendingEvents,
    pollOnce,
    dispatchEvent,
    MAX_DISPATCH_ATTEMPTS,
    LEASE_TIMEOUT_MS
}

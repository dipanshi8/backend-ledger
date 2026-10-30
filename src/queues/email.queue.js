/**
 * Email notification queue — Stage 4 Part B
 *
 * BullMQ queue definition and job producer.
 *
 * The queue uses the shared Redis connection. Jobs are added with deterministic
 * job IDs derived from the outbox event ID so that duplicate dispatch attempts
 * are idempotent (BullMQ will not add a job if the ID already exists).
 *
 * Job retention:
 *   - completedMax: 200 completed jobs kept for inspection
 *   - removeOnComplete: { count: 200 }
 *   - removeOnFail:    { count: 500 } — failed jobs retained for debugging
 *
 * The actual email-sending logic lives in the processor (email.processor.js),
 * not here. This module only defines the queue and the producer function.
 */

const { Queue } = require("bullmq")
const { getRedisClient } = require("../config/redis")
const { logger } = require("../config/logger")

const QUEUE_NAME = "email-notifications"

let queue = null

/**
 * Lazily creates the Queue. Must be called after Redis is connected.
 * If Redis is not available, enqueueEmailJob returns without throwing —
 * the outbox dispatcher will retry the event on the next poll cycle.
 */
function getEmailQueue() {
    if (queue) return queue
    const client = getRedisClient()
    if (!client || client.status !== "ready") {
        return null
    }
    queue = new Queue(QUEUE_NAME, {
        connection: client,
        defaultJobOptions: {
            attempts: 3,
            backoff: {
                type: "exponential",
                delay: 2000  // 2s, 4s, 8s
            },
            removeOnComplete: { count: 200 },
            removeOnFail: { count: 500 }
        }
    })
    logger.info("[email-queue] Queue created")
    return queue
}

/**
 * Enqueue an email notification job.
 *
 * Uses a deterministic job ID (`email:${outboxEventId}`) so that if the
 * dispatcher re-enqueues the same event after a crash, BullMQ deduplicates
 * the job instead of creating a duplicate.
 *
 * @param {object} jobData - Email job payload
 * @param {string} jobData.outboxEventId - Outbox event document _id
 * @param {string} jobData.type - Email type: "registration" | "transaction"
 * @param {string} jobData.to - Recipient email
 * @param {string} jobData.name - Recipient name
 * @param {object} [jobData.context] - Additional context (amount, toAccount, etc.)
 * @returns {Promise<{ jobId: string } | null>} - Job ID if enqueued, null if queue unavailable
 */
async function enqueueEmailJob(jobData) {
    const q = getEmailQueue()
    if (!q) {
        logger.warn("[email-queue] Queue not available, job not enqueued", {
            outboxEventId: jobData.outboxEventId
        })
        return null
    }

    const jobId = `email:${jobData.outboxEventId}`

    try {
        const job = await q.add("send-email", jobData, { jobId })

        if (job) {
            logger.info("[email-queue] Job enqueued", { jobId: job.id || jobId })
            return { jobId: job.id || jobId }
        }

        // Job already exists (deduplicated)
        logger.info("[email-queue] Job already exists (deduplicated)", { jobId })
        return { jobId }
    } catch (err) {
        logger.error("[email-queue] Failed to enqueue job", {
            error: err.message,
            outboxEventId: jobData.outboxEventId
        })
        return null
    }
}

/**
 * Close the queue connection. Used during graceful shutdown.
 */
async function closeEmailQueue() {
    if (queue) {
        await queue.close()
        queue = null
        logger.info("[email-queue] Queue closed")
    }
}

module.exports = {
    QUEUE_NAME,
    getEmailQueue,
    enqueueEmailJob,
    closeEmailQueue
}

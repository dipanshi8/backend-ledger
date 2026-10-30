/**
 * Email notification processor — Stage 4 Part B
 *
 * This is the WORKER-SIDE code. It runs in the worker process (worker.js),
 * not in the API server. The processor:
 *   1. Reads job data from the BullMQ queue
 *   2. Constructs the email using the existing email.service templates
 *   3. Sends it via nodemailer
 *   4. Throws on failure so BullMQ retries with exponential backoff
 *
 * SECURITY: This module never logs JWTs, cookies, SMTP credentials, or
 * financial payload amounts. Only the email type and recipient are logged.
 *
 * EXACTLY-ONCE DISCLAIMER:
 * BullMQ provides at-least-once delivery. In rare crash-recovery scenarios,
 * a job may be processed multiple times, resulting in duplicate emails.
 * This is an inherent property of message queues and is not a bug.
 */

const { Worker } = require("bullmq")
const { getRedisClient } = require("../config/redis")
const { logger } = require("../config/logger")
const { QUEUE_NAME } = require("./email.queue")

const emailService = require("../services/email.service")

/**
 * Processes a single email job.
 * Throws on failure so BullMQ retries with exponential backoff.
 *
 * @param {import('bullmq').Job} job
 */
async function processEmailJob(job) {
    const { type, to, name, context } = job.data

    logger.info("[email-processor] Processing job", {
        jobId: job.id,
        type,
        to: to ? "[present]" : "[missing]"
    })

    switch (type) {
        case "registration":
            await emailService.sendRegistrationEmail(to, name)
            break
        case "transaction":
            await emailService.sendTransactionEmail(to, name, context.amount, context.toAccount)
            break
        case "transaction-failure":
            await emailService.sendTransactionFailureEmail(to, name, context.amount, context.toAccount)
            break
        default:
            logger.warn("[email-processor] Unknown email type, discarding", { type, jobId: job.id })
            return
    }

    logger.info("[email-processor] Job completed", { jobId: job.id, type })
}

/**
 * Starts the BullMQ worker. Returns the worker instance.
 * Call worker.close() during graceful shutdown.
 *
 * @returns {import('bullmq').Worker | null}
 */
function startEmailWorker() {
    const client = getRedisClient()
    if (!client || client.status !== "ready") {
        logger.warn("[email-processor] Redis not available, worker not started")
        return null
    }

    const worker = new Worker(QUEUE_NAME, processEmailJob, {
        connection: client,
        concurrency: 3
    })

    worker.on("completed", (job) => {
        logger.info("[email-processor] Job completed", { jobId: job.id })
    })

    worker.on("failed", (job, err) => {
        logger.error("[email-processor] Job failed", {
            jobId: job?.id,
            error: err.message,
            attempts: job?.attemptsMade
        })
    })

    worker.on("error", (err) => {
        logger.error("[email-processor] Worker error", { error: err.message })
    })

    logger.info("[email-processor] Worker started")
    return worker
}

/**
 * Stops the worker gracefully.
 *
 * @param {import('bullmq').Worker} worker
 * @returns {Promise<void>}
 */
async function stopEmailWorker(worker) {
    if (!worker) return
    await worker.close()
    logger.info("[email-processor] Worker stopped")
}

module.exports = {
    processEmailJob,
    startEmailWorker,
    stopEmailWorker
}

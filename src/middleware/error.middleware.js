/**
 * Centralized error-handling middleware.
 * Formats all unhandled errors into sanitized JSON responses,
 * preventing stack traces, file paths, and database internals from leaking to clients.
 */
function errorHandler(err, req, res, next) {
    if (res.headersSent) {
        return next(err);
    }

    // Malformed JSON request body
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({
            message: "Malformed JSON in request body"
        });
    }

    // Mongoose schema validation error
    if (err.name === 'ValidationError') {
        const firstError = Object.values(err.errors || {})[0];
        const message = firstError ? firstError.message : "Validation error";
        return res.status(400).json({
            message
        });
    }

    // Mongoose cast error (invalid ObjectId, type conversion failure)
    if (err.name === 'CastError') {
        return res.status(400).json({
            message: `Invalid value for ${err.path || 'identifier'}`
        });
    }

    // Explicit client-side operational errors
    if (err.statusCode && typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
        return res.status(err.statusCode).json({
            message: err.message || "Bad Request"
        });
    }

    // Safe server-side error logging for diagnostics
    console.error("Unhandled server error:", err);

    // Generic sanitized 500 response - never expose stack traces, paths, or internals
    return res.status(500).json({
        message: "Internal server error"
    });
}

module.exports = {
    errorHandler
};

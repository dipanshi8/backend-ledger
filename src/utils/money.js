const MAX_AMOUNT_RUPEES = 10_000_000 // 10 million INR / 1 crore INR
const MIN_AMOUNT_RUPEES = 0.01 // 1 paise
const SUPPORTED_CURRENCIES = Object.freeze(["INR"])

/**
 * Validates a monetary amount provided in Rupees.
 * Rejects:
 * - missing, null, undefined
 * - non-numbers, non-finite values (NaN, Infinity, -Infinity)
 * - booleans, objects, arrays, empty strings, string numbers
 * - zero and negative amounts
 * - values exceeding MAX_AMOUNT_RUPEES
 * - exponential notation
 * - values with more than 2 decimal places
 *
 * @param {any} amount
 * @returns {{ isValid: boolean, error?: string, paise?: number, rupees?: number }}
 */
function validateRupeeAmount(amount) {
    if (amount === undefined || amount === null) {
        return {
            isValid: false,
            error: "Amount is required"
        }
    }

    if (typeof amount !== "number" || !Number.isFinite(amount)) {
        return {
            isValid: false,
            error: "Amount must be a valid finite number"
        }
    }

    if (amount <= 0) {
        return {
            isValid: false,
            error: "Amount must be greater than zero"
        }
    }

    if (amount > MAX_AMOUNT_RUPEES) {
        return {
            isValid: false,
            error: `Amount exceeds maximum limit of ₹${MAX_AMOUNT_RUPEES}`
        }
    }

    const str = amount.toString()
    if (str.includes("e") || str.includes("E")) {
        return {
            isValid: false,
            error: "Amount in exponential notation is not allowed"
        }
    }

    const parts = str.split(".")
    if (parts.length > 1 && parts[1].length > 2) {
        return {
            isValid: false,
            error: "Amount cannot have more than 2 decimal places"
        }
    }

    // Convert safely to integer minor units (paise)
    const paise = Math.round(amount * 100)

    if (paise < 1) {
        return {
            isValid: false,
            error: "Amount must be at least ₹0.01 (1 paise)"
        }
    }

    return {
        isValid: true,
        paise,
        rupees: paiseToRupees(paise)
    }
}

/**
 * Converts integer paise to rupees as a standard 2-decimal JavaScript Number.
 * @param {number} paise
 * @returns {number}
 */
function paiseToRupees(paise) {
    if (typeof paise !== "number" || !Number.isFinite(paise)) {
        return 0
    }
    return Number((paise / 100).toFixed(2))
}

/**
 * Converts a validated rupee amount to integer paise.
 * @param {number} rupees
 * @returns {number}
 */
function rupeesToPaise(rupees) {
    if (typeof rupees !== "number" || !Number.isFinite(rupees)) {
        throw new TypeError("rupees must be a finite number")
    }
    return Math.round(rupees * 100)
}

module.exports = {
    MAX_AMOUNT_RUPEES,
    MIN_AMOUNT_RUPEES,
    SUPPORTED_CURRENCIES,
    validateRupeeAmount,
    paiseToRupees,
    rupeesToPaise
}

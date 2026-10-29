const mongoose = require('mongoose');
const ledgerModel = require('./ledger.model');
const { paiseToRupees } = require('../utils/money');

const accountSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user',
        required: [true, 'Account must be associated with a user'],
        index: true
    },

    status: {
        type: String,
        enum: {
            values: ['ACTIVE', 'FROZEN', 'CLOSED'],
            message: 'Status must be either ACTIVE, FROZEN, or CLOSED',
        },
        default: 'ACTIVE'
    },

    currency: {
        type: String,
        required: [true, 'Currency is required'],
        default: 'INR'
    },

    version: {
        type: Number,
        default: 0
    }
}, {
    timestamps: true
});

accountSchema.index({ user: 1, status: 1 });

/**
 * Computes the account's balance in minor units (paise).
 * Uses session if provided in options for transaction-scoped reads.
 * @param {{ session?: mongoose.ClientSession }} options
 * @returns {Promise<number>} balance in paise
 */
accountSchema.methods.getBalanceInPaise = async function(options = {}) {
    const aggregateOpts = {};
    if (options && options.session) {
        aggregateOpts.session = options.session;
    }

    const pipeline = [
        { $match: { account: this._id } },
        {
            $group: {
                _id: null,
                totalDebit: {
                    $sum: {
                        $cond: [
                            { $eq: ['$type', 'DEBIT'] },
                            '$amount',
                            0
                        ]
                    }
                },
                totalCredit: {
                    $sum: {
                        $cond: [
                            { $eq: ['$type', 'CREDIT'] },
                            '$amount',
                            0
                        ]
                    }
                }
            }
        },
        {
            $project: {
                _id: 0,
                balance: { $subtract: ['$totalCredit', '$totalDebit'] }
            }
        }
    ];

    const balanceData = await ledgerModel.aggregate(pipeline, aggregateOpts);

    if (balanceData.length === 0) {
        return 0;
    }
    return balanceData[0].balance;
};

/**
 * Computes the account balance in rupees.
 * @param {{ session?: mongoose.ClientSession }} options
 * @returns {Promise<number>} balance in rupees
 */
accountSchema.methods.getBalance = async function(options = {}) {
    const balanceInPaise = await this.getBalanceInPaise(options);
    return paiseToRupees(balanceInPaise);
};

const accountModel = mongoose.model('account', accountSchema);

module.exports = accountModel;

const mongoose = require('mongoose');
const { paiseToRupees } = require('../utils/money');

const tranactionSchema = new mongoose.Schema({

    fromAccount: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'account', 
        required: [true, 'Transaction must be associated with a from account'],
        index: true
    },

    toAccount: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'account', 
        required: [true, 'Transaction must be associated with a to account'],
        index: true
    },

    currency: {
        type: String,
        enum: ['INR'],
        default: 'INR',
        required: [true, 'Currency is required']
    },

    status: {
        type: String,
        enum:{
            values: ['PENDING','COMPLETED','FAILED','REVERSED'],
            message: 'Status must be either PENDING, COMPLETED, FAILED, or REVERSED'
        },
        default: 'PENDING'
    },

    amount: {
        type: Number,
        required: [true, 'Transaction amount is required'],
        min: [1, 'Transaction amount must be at least 1 minor unit (paise)'],
        validate: {
            validator: Number.isInteger,
            message: 'Transaction amount must be an integer in minor units (paise)'
        }
    },

    idempotencyKey: {
        type: String,
        required: [true, 'Idempotency key is required'],
        index: true,
        unique: true
    }
}, {
    timestamps: true,
    toJSON: {
        transform: (doc, ret) => {
            if (typeof ret.amount === 'number') {
                ret.amount = paiseToRupees(ret.amount);
            }
            return ret;
        }
    },
    toObject: {
        transform: (doc, ret) => {
            if (typeof ret.amount === 'number') {
                ret.amount = paiseToRupees(ret.amount);
            }
            return ret;
        }
    }
});

const transactionModel = mongoose.model('transaction', tranactionSchema);

module.exports = transactionModel;

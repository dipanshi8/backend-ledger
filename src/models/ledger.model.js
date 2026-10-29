const mongoose = require('mongoose');
const { paiseToRupees } = require('../utils/money');

const ledgerSchema = new mongoose.Schema({

    account: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'account',
        required: [true, 'Ledger must be associated with an account'],
        index: true,
        immutable: true
    },

    amount: {
        type: Number,
        required: [true, 'Ledger amount is required'],
        min: [1, 'Ledger amount must be at least 1 minor unit (paise)'],
        validate: {
            validator: Number.isInteger,
            message: 'Ledger amount must be an integer in minor units (paise)'
        },
        immutable: true
    },  

    transaction: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'transaction',
        required: [true, 'Ledger must be associated with a transaction'],
        index: true,
        immutable: true
    },

    type: {
        type: String,
        enum:{
            values: ['DEBIT', 'CREDIT'],
            message: 'Type must be either DEBIT or CREDIT'
        },
        required: [true, 'Ledger type is required'],
        immutable: true
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

function preventLedgerModification() {
    throw new Error('Ledger entries are immutable and cannot be modified or deleted.');
}

ledgerSchema.pre('findOneAndUpdate', preventLedgerModification);
ledgerSchema.pre('updateOne', preventLedgerModification);
ledgerSchema.pre('deleteOne', preventLedgerModification);
ledgerSchema.pre('remove', preventLedgerModification);  
ledgerSchema.pre('deleteMany', preventLedgerModification);
ledgerSchema.pre('updateMany', preventLedgerModification);
ledgerSchema.pre('findOneAndDelete', preventLedgerModification);
ledgerSchema.pre('findOneAndReplace', preventLedgerModification);

const ledgerModel = mongoose.model('ledger', ledgerSchema);

module.exports = ledgerModel;

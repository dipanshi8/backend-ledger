/**
 * Migration Script: Migrate Ledger and Transaction Amounts to Minor Units (Paise)
 *
 * NOTE: DO NOT EXECUTE THIS AGAINST PRODUCTION DATA WITHOUT PRIOR BACKUP AND APPROVAL.
 *
 * Purpose:
 * Converts historical records where `amount` was stored in major units (Rupees, e.g. 50.00)
 * into integer minor units (Paise, e.g. 5000) for exact arithmetic integrity.
 *
 * Usage:
 *   node scripts/migrate-to-minor-units.js --dry-run
 *   node scripts/migrate-to-minor-units.js --apply
 */

const mongoose = require("mongoose")
require("dotenv").config()

const isDryRun = process.argv.includes("--dry-run") || !process.argv.includes("--apply")

async function runMigration() {
    const mongoUri = process.env.MONGO_URI
    if (!mongoUri) {
        console.error("Error: MONGO_URI environment variable is required.")
        process.exit(1)
    }

    console.log(`Starting migration (Mode: ${isDryRun ? "DRY RUN (no changes applied)" : "APPLY CHANGES"})`)
    await mongoose.connect(mongoUri)
    console.log("Connected to MongoDB.")

    const db = mongoose.connection.db
    const transactionsColl = db.collection("transactions")
    const ledgersColl = db.collection("ledgers")

    try {
        // Migrate transactions
        const transactions = await transactionsColl.find({}).toArray()
        console.log(`Found ${transactions.length} transaction records.`)

        let txUpdated = 0
        for (const tx of transactions) {
            // Check if already in minor units or if migration flag present
            if (tx.__migratedToPaise) {
                continue
            }
            const oldAmount = tx.amount
            const newAmount = Math.round(oldAmount * 100)

            console.log(`Transaction ${tx._id}: ${oldAmount} INR -> ${newAmount} paise`)
            if (!isDryRun) {
                await transactionsColl.updateOne(
                    { _id: tx._id },
                    {
                        $set: {
                            amount: newAmount,
                            __migratedToPaise: true,
                            currency: tx.currency || "INR"
                        }
                    }
                )
            }
            txUpdated++
        }

        // Migrate ledger entries
        const ledgers = await ledgersColl.find({}).toArray()
        console.log(`Found ${ledgers.length} ledger records.`)

        let ledgerUpdated = 0
        for (const entry of ledgers) {
            if (entry.__migratedToPaise) {
                continue
            }
            const oldAmount = entry.amount
            const newAmount = Math.round(oldAmount * 100)

            console.log(`Ledger ${entry._id}: ${oldAmount} INR -> ${newAmount} paise`)
            if (!isDryRun) {
                await ledgersColl.updateOne(
                    { _id: entry._id },
                    {
                        $set: {
                            amount: newAmount,
                            __migratedToPaise: true
                        }
                    }
                )
            }
            ledgerUpdated++
        }

        console.log(`\nMigration summary:`)
        console.log(`Transactions to update: ${txUpdated}`)
        console.log(`Ledger entries to update: ${ledgerUpdated}`)
        console.log(`Status: ${isDryRun ? "DRY RUN COMPLETE (no data modified)" : "MIGRATION APPLIED SUCCESSFULLY"}`)
    } catch (err) {
        console.error("Migration failed:", err)
        process.exit(1)
    } finally {
        await mongoose.disconnect()
        console.log("Disconnected from MongoDB.")
    }
}

runMigration()

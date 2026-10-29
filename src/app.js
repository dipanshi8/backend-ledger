const express = require('express');
const cookieParser = require('cookie-parser');
const { errorHandler } = require('./middleware/error.middleware');

const app = express();

app.use(express.json());
app.use(cookieParser());

/**
 * Routes required
 */
const authRouter = require('./routes/auth.routes');
const accountRouter = require('./routes/account.routes');
const transactionRoutes = require('./routes/transaction.routes');

/**
 * Use routes
 */
app.get("/", (req, res) => {
    res.send("Ledger Service is up and running");
});

app.use("/api/auth", authRouter);
app.use("/api/accounts", accountRouter);
app.use('/api/transactions', transactionRoutes);

// Fallback for unmatched routes
app.use((req, res) => {
    res.status(404).json({ message: "Route not found" });
});

// Centralized error handler
app.use(errorHandler);

module.exports = app;

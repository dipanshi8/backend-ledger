
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    email: {
        type: String,
        required: [true, 'Email is required for creating a user'],
        trim: true,
        lowercase: true,
        match: [
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
            'Invalid email format'
        ],
        unique: true
    },

    name: {
        type: String,
        required: [true, 'Name is required for creating a user']
    },

    password: {
        type: String,
        required: [true, 'Password is required for creating a user'],
        minlength: [6, 'Password must be at least 6 characters long'],
        select: false
    }

}, {
    timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function() {
    if (!this.isModified('password')) {
        return;
    }

    const hash = await bcrypt.hash(this.password, 10);
    this.password = hash;
});

// Compare entered password with hashed password
userSchema.methods.comparePassword = async function(password) {
    return await bcrypt.compare(password, this.password);
};

const userModel = mongoose.model('user', userSchema);

module.exports = userModel;

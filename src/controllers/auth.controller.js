const userModel = require('../models/user.model');
const jwt = require('jsonwebtoken');


/**user register controller 
 *- POST /api/auth/register
 */

async function userRegisterController(req, res) {
    const { email, name, password } = req.body;

    const isExists= await userModel.findOne({ 
        email: email 
    });    

    if(isExists){
        return res.status(422).json({
            message: 'Email already exists',
            status: 'failed'
        });
    }

    const user = await userModel.create({
        email,name,password
    });

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
        expiresIn: '3d'})

        res.cookie('token', token)

        res.status(201).json({
            user: {
                email: user.email,
                name: user.name,
                _id: user._id
            },
            token

    })
    
}

/**
 * User login controller
 * -POST /api/auth/login
 */

async function userLoginController(req, res) {
    const { email, password } = req.body;

    const user = await userModel.findOne({ email }).select('+password');

    if (!user) {
        return res.status(401).json({
            message: 'Email or password is invalid',
        });
    }

    const isValidPassword = await user.comparePassword(password);

    if (!isValidPassword) {
        return res.status(401).json({
            message: 'Email or password is invalid',
        });
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
        expiresIn: '3d'
    });

    res.cookie('token', token);

    res.status(200).json({
        user: {
            email: user.email,
            name: user.name,
            _id: user._id
        },
        token
    });
}



module.exports = { 
    userRegisterController ,
    userLoginController
};
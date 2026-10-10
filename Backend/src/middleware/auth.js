const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');

async function authenticateToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  if (!mongoose.isValidObjectId(payload.userId)) throw new Error('Invalid user');
  const user = await User.findById(payload.userId).select('number role');
  if (!user) throw new Error('User no longer exists');
  return { userId: String(user._id), number: user.number, role: user.role };
}

async function auth(req, res, next) {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ message: 'Sign in to continue.' });
  try {
    req.user = await authenticateToken(match[1]);
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError' ||
        error.name === 'NotBeforeError' || error.message === 'Invalid user' ||
        error.message === 'User no longer exists') {
      return res.status(401).json({ message: 'Your session has expired. Sign in again.' });
    }
    next(error);
  }
}

module.exports = auth;
module.exports.authenticateToken = authenticateToken;

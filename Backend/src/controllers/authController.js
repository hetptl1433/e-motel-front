const jwt = require('jsonwebtoken');
const User = require('../models/User');

exports.login = async (req, res) => {
  const { number, password } = req.body || {};
  if (typeof number !== 'string' || !number.trim() || number.length > 100 ||
      typeof password !== 'string' || !password || password.length > 256) {
    return res.status(400).json({ message: 'Enter your ID number and password.' });
  }
  if (!process.env.JWT_SECRET) {
    return res.status(503).json({ message: 'Sign-in is not configured. Contact your administrator.' });
  }
  const user = await User.findOne({ number: number.trim() }).select('+password');
  if (!user) return res.status(401).json({ message: 'Invalid credentials' });

  const match = await user.comparePassword(password);
  if (!match) return res.status(401).json({ message: 'Invalid credentials' });

  const token = jwt.sign(
    { userId: user._id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '365d' }
  );
  res.json({ token, role: user.role, user: { id: user._id, number: user.number, role: user.role } });
};

exports.me = (req, res) => {
  res.json({ user: { id: req.user.userId, number: req.user.number, role: req.user.role } });
};

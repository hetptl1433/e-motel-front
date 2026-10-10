// src/middleware/authorize.js
module.exports = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Sign in to continue.' });

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Your account cannot perform this action.' });
    }

    next();
  };
};

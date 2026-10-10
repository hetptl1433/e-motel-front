// Export the HTTP server so Vercel can handle REST and WebSocket upgrades.
// Backend/server handles cached database and distributed Socket.IO startup.
module.exports = require('../Backend/server').server;

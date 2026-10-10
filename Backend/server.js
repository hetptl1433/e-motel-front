require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const morgan = require('morgan');
const { getMongoConfig, getMongoConfigError, getMongoPreflightError } = require('./src/config/mongo');
const { clientOrigins, createCachedInitializer, createHostedRealtime } = require('./src/config/realtime');
const { authenticateToken } = require('./src/middleware/auth');
const { scheduleTokenExpiry } = require('./src/utils/tokenExpiry');

mongoose.set('bufferCommands', false);
const app = express();
const server = http.createServer(app);
const hosted = process.env.VERCEL === '1';
const allowedOrigins = clientOrigins();
const origin = (value, callback) => {
  if (!value || allowedOrigins.includes(value)) return callback(null, true);
  const error = new Error('This origin is not allowed.');
  error.status = 403;
  callback(error);
};
const dbState = { status: 'disconnected', lastError: null };
const socketState = {
  enabled: process.env.ENABLE_SOCKET_IO !== 'false',
  status: process.env.ENABLE_SOCKET_IO === 'false' ? 'disabled' : hosted ? 'initializing' : 'ready',
  distributed: hosted,
  reason: null
};
const port = Number(process.env.PORT || 4000);
let mongoRetry;
let shuttingDown = false;

app.disable('x-powered-by');
app.use(morgan('dev', { skip: () => process.env.NODE_ENV === 'test' }));
app.use(cors({ origin, credentials: true }));
app.use(express.json({ limit: '2mb' }));

let io;
let hostedRealtime;
if (socketState.enabled) {
  const { Server } = require('socket.io');
  io = new Server(server, {
    cors: { origin, credentials: true },
    ...(hosted && { transports: ['websocket'] }),
    allowRequest: (req, callback) => origin(req.headers.origin, error => callback(null, !error))
  });
  if (hosted) hostedRealtime = createHostedRealtime({ io, connection: mongoose.connection, state: socketState });
  io.use(async (socket, next) => {
    if (hosted) {
      try { await ensureInfrastructure(); }
      catch { return next(new Error(dbState.lastError || socketState.reason || 'Room updates are unavailable.')); }
    }
    if (mongoose.connection.readyState !== 1) return next(new Error('Database unavailable.'));
    try {
      socket.user = await authenticateToken(socket.handshake.auth?.token);
      next();
    } catch {
      next(new Error('Sign in to receive room updates.'));
    }
  });
  io.on('connection', socket => {
    const payload = require('jsonwebtoken').decode(socket.handshake.auth.token);
    const cancelExpiry = scheduleTokenExpiry(payload.exp * 1000, () => socket.disconnect(true));
    socket.on('disconnect', cancelExpiry);
  });
} else {
  socketState.reason = 'Live updates are disabled by configuration.';
  io = { emit() {}, close(callback) { callback?.(); } };
}
app.set('io', io);
app.set('socketState', socketState);
app.set('dbState', dbState);

// Vercel imports the HTTP server without calling start(). Initialize once per
// instance, share concurrent cold-start work, and await it before API routes.
app.use('/api', async (req, res, next) => {
  if (!hosted) return next();
  try {
    await ensureInfrastructure();
    next();
  } catch {
    if (req.path === '/health') return next();
    res.status(503).json({ message: dbState.lastError || socketState.reason || 'The service is unavailable. Please try again shortly.' });
  }
});
if (hostedRealtime) app.use('/api', hostedRealtime.middleware);

app.get('/api/health', (req, res) => {
  const databaseReady = mongoose.connection.readyState === 1;
  const ready = databaseReady && (!socketState.enabled || socketState.status === 'ready') && Boolean(process.env.JWT_SECRET);
  res.status(ready ? 200 : 503).json({
    ok: ready,
    port,
    mongo: { status: databaseReady ? 'connected' : dbState.status, lastError: dbState.lastError },
    socket: socketState
  });
});
app.use('/api', (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ message: 'The database is unavailable. Please try again shortly.' });
  }
  next();
});
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/room', require('./src/routes/room'));
app.use('/api/housekeeper', require('./src/routes/housekeeper'));
app.use('/api/roomSheet', require('./src/routes/roomSheet'));
app.use('/api', require('./routes/roomSheet'));
app.use('/api', (req, res) => res.status(404).json({ message: 'API endpoint not found.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  let status = error.status || 500;
  let message = status < 500 ? error.message : 'The request could not be completed. Please try again.';
  if (error.name === 'ValidationError' || error.name === 'CastError') {
    status = 400;
    message = 'Invalid request data.';
  }
  if (error.code === 11000) {
    status = 409;
    message = 'A record with these details already exists.';
  }
  if (error.name === 'MulterError') {
    status = 400;
    message = error.code === 'LIMIT_FILE_SIZE' ? 'The file is too large (maximum 10 MB).' : 'Invalid report upload.';
  }
  if (status >= 500) console.error('Request failed:', error.name || 'Error');
  res.status(status).json({ message });
});

mongoose.connection.on('connected', () => {
  dbState.status = 'connected';
  dbState.lastError = null;
});
mongoose.connection.on('disconnected', () => {
  dbState.status = 'disconnected';
  hostedRealtime?.unavailable('The database connection was lost. Live updates will reconnect when it is available.');
});
mongoose.connection.on('error', () => {
  dbState.status = 'error';
  dbState.lastError = 'Unable to connect to the database.';
});

async function connectDatabase() {
  if (!process.env.JWT_SECRET) {
    dbState.status = 'missing-config';
    dbState.lastError = 'Set JWT_SECRET before starting the server.';
    throw new Error(dbState.lastError);
  }
  const config = getMongoConfig();
  const configError = getMongoConfigError(config);
  if (configError) {
    dbState.status = 'missing-config';
    dbState.lastError = configError;
    throw new Error(configError);
  }
  try {
    dbState.status = 'connecting';
    const preflightError = await getMongoPreflightError(config);
    if (preflightError) throw new Error(preflightError);
    await mongoose.connect(config.uri, { serverSelectionTimeoutMS: 5000, ...(hosted && { maxPoolSize: 10, minPoolSize: 0 }) });
    dbState.status = 'connected';
    dbState.lastError = null;
  } catch {
    dbState.status = 'error';
    dbState.lastError = 'Unable to connect to MongoDB. Check the connection string and network access.';
    throw new Error(dbState.lastError);
  }
}

const ensureInfrastructure = createCachedInitializer({
  isDatabaseReady: () => mongoose.connection.readyState === 1 && Boolean(process.env.JWT_SECRET),
  connectDatabase,
  isRealtimeReady: () => !hostedRealtime || socketState.status === 'ready',
  initializeRealtime: () => hostedRealtime.initialize()
});

async function connectToMongo() {
  try {
    await ensureInfrastructure();
    return true;
  } catch {
    // Local development keeps its existing recovery loop. Hosted requests
    // retry initialization on demand instead of relying on frozen timers.
    if (!hosted && !shuttingDown) {
      clearTimeout(mongoRetry);
      mongoRetry = setTimeout(connectToMongo, 15000);
      mongoRetry.unref();
    }
    return false;
  }
}

async function start() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  if (!process.env.JWT_SECRET) throw new Error('Set JWT_SECRET before starting the server.');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, process.env.HOST || '127.0.0.1', resolve);
  });
  console.log(`Server running at http://${process.env.HOST || '127.0.0.1'}:${port}`);
  await connectToMongo();
  return server;
}

async function stop() {
  shuttingDown = true;
  clearTimeout(mongoRetry);
  await new Promise(resolve => io.close(resolve));
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
}

if (require.main === module) {
  start().catch(error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => stop().then(() => process.exit(0)));
  }
}

module.exports = { app, server, start, stop, connectToMongo, ensureInfrastructure };

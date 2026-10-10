const { AsyncLocalStorage } = require('node:async_hooks');

const LIVE_UNAVAILABLE = 'Live updates are temporarily unavailable. Refresh the board for the latest room statuses.';

function clientOrigins(env = process.env) {
  const origins = [
    'http://localhost:3000', 'http://localhost:3001',
    'http://127.0.0.1:3000', 'http://127.0.0.1:3001',
    ...(env.CLIENT_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
  ];
  for (const hostname of [env.VERCEL_URL, env.VERCEL_PROJECT_PRODUCTION_URL]) {
    if (hostname) {
      try { origins.push(new URL(`https://${hostname}`).origin); } catch { /* Ignore invalid deployment metadata. */ }
    }
  }
  return [...new Set(origins)];
}

function createCachedInitializer({ isDatabaseReady, connectDatabase, isRealtimeReady, initializeRealtime }) {
  let pending;
  return function ensureReady() {
    if (isDatabaseReady() && isRealtimeReady()) return Promise.resolve();
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        if (!isDatabaseReady()) await connectDatabase();
        if (!isDatabaseReady()) throw new Error('Database unavailable.');
        if (!isRealtimeReady()) await initializeRealtime();
      }).finally(() => { pending = undefined; });
    }
    return pending;
  };
}

// The Mongo adapter publishes asynchronously, while io.emit() returns a boolean.
// Observe public collection writes instead of relying on adapter internals, and
// keep each HTTP response open until its own notifications have been persisted.
function createPublicationTracker(onFailure = () => {}) {
  const storage = new AsyncLocalStorage();
  const context = () => ({ writes: [], failures: [], active: true });
  const observe = promise => {
    const inherited = storage.getStore();
    const current = inherited?.active ? inherited : undefined;
    const observed = Promise.resolve(promise);
    if (current) current.writes.push(observed);
    observed.catch(error => {
      if (current) current.failures.push(error);
      onFailure(error);
    });
    return observed;
  };
  const settle = async current => {
    let settled = 0;
    while (settled < current.writes.length) {
      const batch = current.writes.slice(settled);
      settled += batch.length;
      await Promise.allSettled(batch);
    }
  };
  const collection = (source, watchStream = () => {}) => new Proxy(source, {
    get(target, property) {
      if (property === 'insertOne') return (...args) => {
        try { return observe(target.insertOne(...args)); }
        catch (error) { return observe(Promise.reject(error)); }
      };
      if (property === 'watch') return (...args) => {
        const stream = target.watch(...args);
        watchStream(stream);
        return stream;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const run = callback => {
    const current = context();
    return storage.run(current, async () => {
      let result, failure;
      try { result = await callback(); } catch (error) { failure = error; }
      await settle(current);
      current.active = false;
      if (failure) throw failure;
      if (current.failures.length) throw new Error(LIVE_UNAVAILABLE);
      return result;
    });
  };
  const middleware = (req, res, next) => {
    const current = context();
    const end = res.end;
    let ending = false;
    res.end = function (...args) {
      if (!current.writes.length) { current.active = false; return end.apply(this, args); }
      if (ending) return this;
      ending = true;
      settle(current).then(() => {
        current.active = false;
        // Preserve a successful database save even when its notification fails,
        // while making that incomplete synchronization visible to the caller.
        if (current.failures.length && !res.headersSent && res.statusCode < 400) {
          res.setHeader('X-Live-Updates', 'unavailable');
          if (String(res.getHeader('Content-Type') || '').includes('application/json') && args[0]) {
            try {
              const body = JSON.parse(String(args[0]));
              body.warning = [body.warning, LIVE_UNAVAILABLE].filter(Boolean).join(' ');
              if (Array.isArray(body.warnings)) body.warnings.push(LIVE_UNAVAILABLE);
              args[0] = JSON.stringify(body);
              res.removeHeader('Content-Length');
              res.removeHeader('ETag');
            } catch { /* Leave non-object JSON responses intact. */ }
          }
        }
        end.apply(res, args);
      });
      return this;
    };
    storage.run(current, next);
  };
  return { collection, run, middleware };
}

function createHostedRealtime({ io, connection, state, adapterFactory = (...args) => require('@socket.io/mongo-adapter').createAdapter(...args) }) {
  const streams = new Set();
  const unavailable = reason => {
    state.status = 'unavailable';
    state.reason = reason || LIVE_UNAVAILABLE;
    // Existing clients must lose their live indicator when cross-instance
    // delivery stops. The local flag avoids another failed Mongo publication.
    try { io.local.disconnectSockets(true); } catch { /* A closing transport may already be gone. */ }
  };
  const tracker = createPublicationTracker(() => unavailable());
  const initialize = async () => {
    state.status = 'initializing';
    state.reason = null;
    streams.clear();
    try {
      await io.of('/').adapter.close();
      const database = connection.db;
      const topology = await database.admin().command({ hello: 1 });
      if (!topology.setName && topology.msg !== 'isdbgrid') {
        throw new Error('Live updates require a MongoDB replica set or sharded cluster.');
      }
      const events = database.collection('room_realtime_events');
      await events.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600, name: 'room_realtime_expiry' });
      // Opening a change stream validates permissions before accepting clients;
      // the adapter normally handles these errors in the background.
      const probe = events.watch([], { maxAwaitTimeMS: 500 });
      try { await probe.tryNext(); } finally { await probe.close(); }
      const tracked = tracker.collection(events, stream => {
        streams.add(stream);
        stream.on('error', () => { if (streams.has(stream)) unavailable(); });
        stream.on('close', () => { if (streams.has(stream)) unavailable(); });
      });
      await tracker.run(() => io.adapter(adapterFactory(tracked, { addCreatedAtField: true })));
      if (state.status === 'unavailable') throw new Error(LIVE_UNAVAILABLE);
      state.status = 'ready';
      state.reason = null;
    } catch (error) {
      unavailable(error.message === 'Live updates require a MongoDB replica set or sharded cluster.'
        ? error.message : 'Live updates could not start. Check MongoDB replica-set and change-stream access.');
      throw new Error(state.reason);
    }
  };
  return { initialize, middleware: tracker.middleware, unavailable };
}

module.exports = { clientOrigins, createCachedInitializer, createPublicationTracker, createHostedRealtime, LIVE_UNAVAILABLE };

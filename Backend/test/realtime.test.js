const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  clientOrigins, createCachedInitializer, createPublicationTracker, createHostedRealtime, LIVE_UNAVAILABLE
} = require('../src/config/realtime');

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function response(statusCode = 200) {
  const completed = deferred();
  const headers = new Map([
    ['content-type', 'application/json; charset=utf-8'], ['content-length', '123'], ['etag', 'old-body-etag']
  ]);
  const res = {
    statusCode, headersSent: false, ends: 0, body: null, completed: completed.promise,
    getHeader(name) { return headers.get(name.toLowerCase()); },
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    removeHeader(name) { headers.delete(name.toLowerCase()); },
    end(body, encoding, callback) {
      this.ends += 1; this.body = body; this.headersSent = true;
      completed.resolve(); callback?.(); return this;
    }
  };
  return res;
}

function changeStream() {
  const stream = new EventEmitter();
  stream.closed = false;
  stream.tryNext = async () => null;
  stream.close = async () => { stream.closed = true; stream.emit('close'); };
  return stream;
}

function hostedFixture({ topology = { setName: 'offline-test-replica' }, publication = Promise.resolve({ insertedId: 'event' }), probeError } = {}) {
  const probes = [], indexes = [], commands = [], streams = [], disconnects = [];
  let closed = 0, installed = 0;
  const state = { enabled: true, status: 'initializing', reason: null };
  const events = {
    createIndex: async (...args) => { indexes.push(args); },
    insertOne: () => publication,
    watch(...args) {
      const stream = changeStream();
      if (args[1]?.maxAwaitTimeMS) {
        probes.push(stream);
        stream.tryNext = async () => { if (probeError) throw probeError; return null; };
      } else streams.push(stream);
      return stream;
    }
  };
  const connection = { db: {
    admin: () => ({ command: async value => { commands.push(value); return topology; } }),
    collection(name) { assert.equal(name, 'room_realtime_events'); return events; }
  } };
  const io = {
    of(name) { assert.equal(name, '/'); return { adapter: { close() { closed += 1; } } }; },
    local: { disconnectSockets(value) { disconnects.push(value); } },
    adapter(factory) { installed += 1; factory(); return this; }
  };
  const adapterFactory = (collection, options) => {
    assert.deepEqual(options, { addCreatedAtField: true });
    return () => {
      collection.watch([]);
      // Match the official adapter: construction publishes its initial
      // heartbeat asynchronously and the public io.adapter call returns io.
      collection.insertOne({ type: 'initial-heartbeat' }).catch(() => {});
    };
  };
  const realtime = createHostedRealtime({ io, connection, state, adapterFactory });
  return { realtime, state, probes, indexes, commands, streams, disconnects, get closed() { return closed; }, get installed() { return installed; } };
}

test('CORS allows exact deployment URLs and configured origins without allowing other Vercel sites', () => {
  const origins = clientOrigins({
    CLIENT_ORIGINS: ' https://motel.example ,http://localhost:3000,https://motel.example ',
    VERCEL_URL: 'e-motel-preview-team.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'e-motel-front.vercel.app'
  });
  assert.ok(origins.includes('https://e-motel-preview-team.vercel.app'));
  assert.ok(origins.includes('https://e-motel-front.vercel.app'));
  assert.ok(origins.includes('https://motel.example'));
  assert.equal(origins.filter(value => value === 'https://motel.example').length, 1);
  assert.equal(origins.includes('https://another-project.vercel.app'), false);
  assert.equal(origins.includes('https://e-motel-front.vercel.app.evil.example'), false);
  assert.equal(clientOrigins({ VERCEL_URL: 'invalid host' }).some(value => value.includes('invalid')), false);
});

test('concurrent cold starts share database and adapter initialization in the correct order', async () => {
  const connected = deferred();
  const order = [];
  let databaseReady = false, realtimeReady = false;
  const ready = createCachedInitializer({
    isDatabaseReady: () => databaseReady, isRealtimeReady: () => realtimeReady,
    connectDatabase: async () => { order.push('connect'); await connected.promise; databaseReady = true; },
    initializeRealtime: async () => { assert.ok(databaseReady); order.push('adapter'); realtimeReady = true; }
  });
  const first = ready(), second = ready();
  assert.equal(first, second);
  await tick();
  assert.deepEqual(order, ['connect']);
  connected.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['connect', 'adapter']);
  await ready();
  assert.deepEqual(order, ['connect', 'adapter']);
});

test('a failed database cold start clears the cache and can recover on the next request', async () => {
  let attempts = 0, databaseReady = false, adapterCalls = 0;
  const ready = createCachedInitializer({
    isDatabaseReady: () => databaseReady, isRealtimeReady: () => adapterCalls > 0,
    connectDatabase: async () => { attempts += 1; if (attempts === 1) throw new Error('offline outage'); databaseReady = true; },
    initializeRealtime: async () => { adapterCalls += 1; }
  });
  await assert.rejects(ready(), /offline outage/);
  assert.equal(adapterCalls, 0);
  await ready();
  assert.equal(attempts, 2);
  assert.equal(adapterCalls, 1);
});

test('a failed adapter retries without reopening a healthy database', async () => {
  let attempts = 0, realtimeReady = false;
  const ready = createCachedInitializer({
    isDatabaseReady: () => true, isRealtimeReady: () => realtimeReady,
    connectDatabase: async () => assert.fail('The connected database must be reused'),
    initializeRealtime: async () => { attempts += 1; if (attempts === 1) throw new Error('stream unavailable'); realtimeReady = true; }
  });
  await assert.rejects(ready(), /stream unavailable/);
  await ready();
  assert.equal(attempts, 2);
});

test('a connect callback that does not establish a database cannot advance to realtime', async () => {
  const ready = createCachedInitializer({
    isDatabaseReady: () => false, isRealtimeReady: () => false,
    connectDatabase: async () => {}, initializeRealtime: async () => assert.fail('Unavailable database must not initialize sockets')
  });
  await assert.rejects(ready(), /Database unavailable/);
});

test('tracked initialization waits for unreturned adapter writes and subsequent writes queued during settlement', async () => {
  const first = deferred(), second = deferred();
  const tracker = createPublicationTracker();
  const writes = [first.promise, second.promise];
  const collection = tracker.collection({ insertOne: () => writes.shift() });
  let complete = false;
  const initialization = tracker.run(() => {
    collection.insertOne({ event: 'one' }).then(() => collection.insertOne({ event: 'two' }));
    return 'ready';
  }).then(value => { complete = true; return value; });
  await tick();
  assert.equal(complete, false);
  first.resolve();
  await tick();
  assert.equal(complete, false);
  second.resolve();
  assert.equal(await initialization, 'ready');
});

test('concurrent HTTP requests wait only for their own publications', async () => {
  const slow = deferred(), fast = deferred();
  const tracker = createPublicationTracker();
  const collection = tracker.collection({ insertOne: record => record.request === 'slow' ? slow.promise : fast.promise });
  const slowResponse = response(), fastResponse = response();
  tracker.middleware({}, slowResponse, () => {
    collection.insertOne({ request: 'slow' }).catch(() => {});
    slowResponse.end(JSON.stringify({ saved: 'slow' }));
  });
  tracker.middleware({}, fastResponse, () => {
    collection.insertOne({ request: 'fast' }).catch(() => {});
    fastResponse.end(JSON.stringify({ saved: 'fast' }));
  });
  assert.equal(slowResponse.ends, 0);
  assert.equal(fastResponse.ends, 0);
  fast.resolve();
  await fastResponse.completed;
  assert.equal(slowResponse.ends, 0);
  assert.deepEqual(JSON.parse(fastResponse.body), { saved: 'fast' });
  slow.resolve();
  await slowResponse.completed;
  assert.equal(slowResponse.ends, 1);
});

test('a failed publication preserves the saved response and adds a visible synchronization warning', async () => {
  const publication = deferred();
  const failures = [];
  const tracker = createPublicationTracker(error => failures.push(error));
  const collection = tracker.collection({ insertOne: () => publication.promise });
  const res = response();
  const saved = { success: true, data: { _id: 'room-101' }, warning: 'Existing warning.', warnings: [] };
  tracker.middleware({}, res, () => {
    collection.insertOne({ event: 'saved' }).catch(() => {});
    res.end(JSON.stringify(saved));
    res.end('must not end twice');
  });
  publication.reject(new Error('test-only write outage'));
  await res.completed;
  assert.equal(res.statusCode, 200);
  assert.equal(res.ends, 1);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.data, saved.data);
  assert.equal(body.success, true);
  assert.equal(body.warning, `Existing warning. ${LIVE_UNAVAILABLE}`);
  assert.deepEqual(body.warnings, [LIVE_UNAVAILABLE]);
  assert.equal(res.getHeader('X-Live-Updates'), 'unavailable');
  assert.equal(res.getHeader('Content-Length'), undefined);
  assert.equal(res.getHeader('ETag'), undefined);
  assert.equal(failures.length, 1);
});

test('background writes do not hold unrelated HTTP responses open', async () => {
  const background = deferred();
  const tracker = createPublicationTracker();
  const collection = tracker.collection({ insertOne: () => background.promise });
  collection.insertOne({ heartbeat: true }).catch(() => {});
  const res = response();
  tracker.middleware({}, res, () => res.end(JSON.stringify({ ok: true })));
  await res.completed;
  assert.equal(res.ends, 1);
  background.resolve();
});

test('synchronous publication failures are tracked and initialization reports failure after settlement', async () => {
  const failures = [];
  const tracker = createPublicationTracker(error => failures.push(error));
  const collection = tracker.collection({ insertOne() { throw new Error('synchronous offline failure'); } });
  await assert.rejects(tracker.run(() => { collection.insertOne({}).catch(() => {}); }), new RegExp(LIVE_UNAVAILABLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(failures.length, 1);
});

test('hosted initialization validates replica set and change streams, installs TTL adapter, and waits for its heartbeat', async () => {
  const publication = deferred();
  const fixture = hostedFixture({ publication: publication.promise });
  const ready = fixture.realtime.initialize();
  await tick();
  assert.equal(fixture.closed, 1, 'The default adapter close method may return void');
  assert.deepEqual(fixture.commands, [{ hello: 1 }]);
  assert.deepEqual(fixture.indexes, [[{ createdAt: 1 }, { expireAfterSeconds: 3600, name: 'room_realtime_expiry' }]]);
  assert.equal(fixture.probes[0].closed, true);
  assert.equal(fixture.installed, 1);
  assert.equal(fixture.state.status, 'initializing');
  publication.resolve({ insertedId: 'initial-heartbeat' });
  await ready;
  assert.equal(fixture.state.status, 'ready');
  assert.equal(fixture.state.reason, null);
  fixture.streams[0].emit('error', new Error('offline stream outage'));
  assert.equal(fixture.state.status, 'unavailable');
  assert.equal(fixture.state.reason, LIVE_UNAVAILABLE);
  assert.deepEqual(fixture.disconnects, [true]);
});

test('standalone MongoDB fails hosted realtime with a clear status before installing the adapter', async () => {
  const fixture = hostedFixture({ topology: { isWritablePrimary: true } });
  await assert.rejects(fixture.realtime.initialize(), /replica set or sharded cluster/);
  assert.equal(fixture.installed, 0);
  assert.equal(fixture.state.status, 'unavailable');
  assert.match(fixture.state.reason, /replica set or sharded cluster/);
  assert.deepEqual(fixture.disconnects, [true]);
});

test('change-stream permissions and initial publication failures cannot produce a ready status', async () => {
  const denied = hostedFixture({ probeError: new Error('offline access denied') });
  await assert.rejects(denied.realtime.initialize(), /change-stream access/);
  assert.equal(denied.probes[0].closed, true);
  assert.equal(denied.installed, 0);
  assert.equal(denied.state.status, 'unavailable');

  const publication = deferred();
  const failed = hostedFixture({ publication: publication.promise });
  const ready = failed.realtime.initialize();
  await tick();
  publication.reject(new Error('offline adapter write failure'));
  await assert.rejects(ready, /change-stream access/);
  assert.equal(failed.state.status, 'unavailable');
  assert.ok(failed.disconnects.length > 0);
});

test('a recovered adapter ignores closure events from a replaced change stream', async () => {
  const fixture = hostedFixture({ topology: { msg: 'isdbgrid' } });
  await fixture.realtime.initialize();
  const obsolete = fixture.streams[0];
  await fixture.realtime.initialize();
  obsolete.emit('close');
  assert.equal(fixture.state.status, 'ready');
  fixture.streams[1].emit('close');
  assert.equal(fixture.state.status, 'unavailable');
});

test('the installed Socket.IO Mongo adapter works with the tracked collection without opening a database or port', async t => {
  const { createServer } = require('node:http');
  const { Server } = require('socket.io');
  const io = new Server(createServer());
  t.after(() => new Promise(resolve => { io.close(resolve); }));
  const heartbeat = deferred();
  const streams = [], publications = [];
  const events = {
    createIndex: async () => {},
    watch() { const stream = changeStream(); streams.push(stream); return stream; },
    insertOne(document) { publications.push(document); return heartbeat.promise; }
  };
  const connection = { db: {
    admin: () => ({ command: async () => ({ setName: 'offline-test-replica' }) }),
    collection: () => events
  } };
  const state = { status: 'initializing' };
  const realtime = createHostedRealtime({ io, connection, state });
  const ready = realtime.initialize();
  await tick();
  assert.equal(state.status, 'initializing');
  assert.equal(streams.length, 2, 'Readiness probe and official adapter each open a tracked stream');
  assert.equal(streams[0].closed, true);
  assert.equal(publications.length, 1);
  assert.equal(publications[0].nsp, '/');
  assert.ok(publications[0].createdAt instanceof Date);
  heartbeat.resolve({ insertedId: Buffer.from('0123456789abcdef', 'hex') });
  await ready;
  assert.equal(state.status, 'ready');
  assert.equal(io.of('/').adapter.constructor.name, 'MongoAdapter');
});

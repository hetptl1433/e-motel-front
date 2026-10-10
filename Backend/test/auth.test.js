const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');
const auth = require('../src/middleware/auth');
const authorize = require('../src/middleware/authorize');
const { login, me } = require('../src/controllers/authController');

const secret = 'offline-test-secret-not-used-by-the-application';
const userId = new mongoose.Types.ObjectId();
const originalSecret = process.env.JWT_SECRET;
test.before(() => { process.env.JWT_SECRET = secret; });
test.after(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});
const response = () => ({ statusCode: 200, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });
const selectQuery = (value, expected) => ({ select(fields) { if (expected) assert.equal(fields, expected); return Promise.resolve(value); } });
const sign = (payload = {}, options = {}) => jwt.sign({ userId: userId.toString(), role: 'admin', ...payload }, secret, { expiresIn: '8h', ...options });

async function authenticate(header) {
  const req = { headers: { authorization: header } };
  const res = response();
  let advanced = false;
  let failure;
  await auth(req, res, error => { advanced = true; failure = error; });
  return { req, res, advanced, failure };
}

test('login rejects malformed input before any database query', async t => {
  let reads = 0;
  t.mock.method(User, 'findOne', () => { reads++; throw new Error('Must not query'); });
  for (const body of [undefined, {}, { number: { $ne: null }, password: 'password' }, { number: '101', password: [] }, { number: ' ', password: 'password' }, { number: '101', password: 'x'.repeat(257) }]) {
    const res = response();
    await login({ body }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(reads, 0);
});

test('successful login authorizes exactly 365 days and returns only safe user identity', async t => {
  const passwordHash = await bcrypt.hash('motel-offline-test-password', 4);
  const user = new User({ _id: userId, number: '201', role: 'frontdesk', password: passwordHash });
  t.mock.method(User, 'findOne', filter => {
    assert.deepEqual(filter, { number: '201' });
    return selectQuery(user, '+password');
  });
  const res = response();
  await login({ body: { number: ' 201 ', password: 'motel-offline-test-password' } }, res);
  assert.equal(res.statusCode, 200);
  const payload = jwt.verify(res.body.token, secret, { algorithms: ['HS256'] });
  assert.equal(payload.userId, userId.toString());
  assert.equal(payload.role, 'frontdesk');
  const lifetime = 365 * 24 * 3600;
  assert.equal(payload.exp - payload.iat, lifetime);
  assert.equal(jwt.verify(res.body.token, secret, { algorithms: ['HS256'], clockTimestamp: payload.iat + lifetime - 1 }).userId, userId.toString());
  assert.throws(() => jwt.verify(res.body.token, secret, { algorithms: ['HS256'], clockTimestamp: payload.exp }), { name: 'TokenExpiredError' });
  assert.equal(res.body.user.role, 'frontdesk');
  assert.equal(res.body.user.number, '201');
  assert.equal(res.body.password, undefined);
  assert.equal(res.body.user.password, undefined);
  assert.equal(JSON.stringify(res.body).includes(passwordHash), false);
});

test('wrong passwords and unknown users produce the same credential error', async t => {
  const user = new User({ _id: userId, number: '201', role: 'frontdesk', password: await bcrypt.hash('correct-password', 4) });
  let selectedUser = user;
  t.mock.method(User, 'findOne', () => selectQuery(selectedUser));
  const wrong = response();
  await login({ body: { number: '201', password: 'wrong-password' } }, wrong);
  selectedUser = null;
  const missing = response();
  await login({ body: { number: '999', password: 'wrong-password' } }, missing);
  assert.equal(wrong.statusCode, 401);
  assert.equal(missing.statusCode, 401);
  assert.deepEqual(wrong.body, missing.body);
  assert.equal(wrong.body.token, undefined);
});

test('authenticated role follows the current account instead of a stale token claim', async t => {
  t.mock.method(User, 'findById', id => {
    assert.equal(id, userId.toString());
    return selectQuery({ _id: userId, number: '201', role: 'frontdesk' }, 'number role');
  });
  const result = await authenticate(`Bearer ${sign({ role: 'admin' })}`);
  assert.equal(result.advanced, true);
  assert.equal(result.failure, undefined);
  assert.equal(result.req.user.role, 'frontdesk');
  assert.equal(result.req.user.userId, userId.toString());
  assert.equal(result.req.user.password, undefined);
  const forbidden = response();
  authorize(['admin'])(result.req, forbidden, () => assert.fail('Stale admin token must not authorize'));
  assert.equal(forbidden.statusCode, 403);
});

test('bad bearer headers, expired tokens, and disallowed algorithms fail before user lookup', async t => {
  let reads = 0;
  t.mock.method(User, 'findById', () => { reads++; throw new Error('Must not query'); });
  const invalidTokens = [undefined, '', 'Basic abc', 'Bearer token with spaces', 'Bearer malformed', `Bearer ${sign({}, { expiresIn: -1 })}`, `Bearer ${sign({}, { algorithm: 'HS384' })}`, `Bearer ${sign({ userId: 'not-an-object-id' })}`];
  for (const header of invalidTokens) {
    const result = await authenticate(header);
    assert.equal(result.res.statusCode, 401);
    assert.equal(result.advanced, false);
    assert.equal(result.res.body.token, undefined);
  }
  assert.equal(reads, 0);
});

test('tokens for deleted users cannot continue authenticating', async t => {
  t.mock.method(User, 'findById', () => selectQuery(null));
  const result = await authenticate(`Bearer ${sign()}`);
  assert.equal(result.res.statusCode, 401);
  assert.equal(result.advanced, false);
});

test('database failures are forwarded without converting an outage into a bad password', async t => {
  const outage = new Error('Temporary database outage');
  t.mock.method(User, 'findById', () => ({ select: () => Promise.reject(outage) }));
  const result = await authenticate(`Bearer ${sign()}`);
  assert.equal(result.advanced, true);
  assert.equal(result.failure, outage);
  assert.equal(result.res.body, null);
});

test('role middleware and the session endpoint expose the current account contract', () => {
  const unauthenticated = response();
  authorize(['admin'])({}, unauthenticated, () => assert.fail('Missing session must not authorize'));
  assert.equal(unauthenticated.statusCode, 401);
  const user = { userId: userId.toString(), number: '301', role: 'admin' };
  let advanced = false;
  authorize(['admin'])({ user }, response(), () => { advanced = true; });
  assert.equal(advanced, true);
  const res = response();
  me({ user }, res);
  assert.deepEqual(res.body, { user: { id: user.userId, number: '301', role: 'admin' } });
});

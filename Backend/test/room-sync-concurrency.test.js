const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const RoomReport = require('../src/models/RoomReport');
const Housekeeper = require('../src/models/Housekeeper');
const rooms = require('../src/controllers/roomController');
const housekeeping = require('../src/controllers/housekeeperController');
const { expectedVersion } = require('../src/utils/roomData');

const id = () => new mongoose.Types.ObjectId().toString();
const clone = value => structuredClone(value);
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
function request(overrides = {}) {
  const events = [];
  return { params: {}, body: {}, user: { role: 'frontdesk' }, app: { get: () => ({ emit: (...event) => events.push(event) }) }, events, ...overrides };
}
function matches(record, filter) {
  return Object.entries(filter).every(([field, value]) => {
    if (field === 'reportDate' && value?.$gte) return record.reportDate >= value.$gte && record.reportDate < value.$lt;
    if (value == null) return record[field] == null;
    if (value instanceof Date) return new Date(record[field]).getTime() === value.getTime();
    return String(record[field]) === String(value);
  });
}

// In-memory model methods retain the conditional-update behavior that matters
// here, including evaluating a CAS only after a delayed write reaches storage.
function memoryModel(t, Model, records, clock, hooks = {}) {
  const apply = async (filter, update) => {
    await hooks.beforeWrite?.(filter, update);
    const index = records.findIndex(record => matches(record, filter));
    if (index < 0) return null;
    records[index] = { ...records[index], ...clone(update.$set || {}), updatedAt: clock() };
    return clone(records[index]);
  };
  t.mock.method(Model, 'findById', async value => clone(records.find(record => record._id === String(value)) || null));
  t.mock.method(Model, 'find', async filter => clone(records.filter(record => matches(record, filter))));
  t.mock.method(Model, 'findOneAndUpdate', apply);
  t.mock.method(Model, 'findByIdAndUpdate', (value, update) => apply({ _id: value }, update));
  t.mock.method(Model, 'updateOne', async (filter, update) => {
    if (records.some(record => matches(record, filter))) return { matchedCount: 1, upsertedCount: 0 };
    records.push({ _id: filter._id || id(), ...clone(update.$setOnInsert) });
    return { upsertedCount: 1 };
  });
}

function fixture() {
  let time = Date.parse('2026-10-10T12:00:00Z');
  const clock = () => new Date(time += 1000);
  const shared = { reportDate: new Date('2026-10-10'), housekeepingStatus: 'Clean', occupancyStatus: 'Occupied', guestStatus: 'Due Out', updatedAt: new Date('2026-10-10T11:00:00Z') };
  return {
    clock,
    reports: [{ _id: id(), room: '101', ...shared }],
    staff: [{ _id: id(), roomNumber: '101', ...shared, cleanedAt: new Date('2026-10-10T10:00:00Z'), inspectedAt: new Date('2026-10-10T10:30:00Z') }]
  };
}

test('checkout retry repairs an existing housekeeping record after a failed first synchronization', async t => {
  const { reports, staff, clock } = fixture();
  let failSync = true;
  memoryModel(t, RoomReport, reports, clock);
  memoryModel(t, Housekeeper, staff, clock, { beforeWrite() { if (failSync) { failSync = false; throw new Error('Injected synchronization failure'); } } });
  const first = response();
  await rooms.checkoutRoom(request({ params: { id: reports[0]._id } }), first);
  assert.equal(first.statusCode, 200);
  assert.match(first.body.warning, /synchronization failed/);
  assert.equal(staff[0].occupancyStatus, 'Occupied');
  const retry = response();
  await rooms.checkoutRoom(request({ params: { id: reports[0]._id }, body: { expectedUpdatedAt: first.body.data.updatedAt.toISOString() } }), retry);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.warning, undefined);
  assert.equal(staff[0].occupancyStatus, 'Vacant');
  assert.equal(staff[0].housekeepingStatus, 'Dirty');
  assert.equal(staff[0].cleanedAt, null);
  assert.equal(staff[0].inspectedAt, null);
  assert.equal(staff[0].checkedOutAt.getTime(), reports[0].checkedOutAt.getTime());
});

test('a delayed checkout synchronization cannot undo a newer check-in on either board', async t => {
  const { reports, staff, clock } = fixture();
  const entered = deferred(), release = deferred();
  let delayed = false;
  memoryModel(t, RoomReport, reports, clock);
  memoryModel(t, Housekeeper, staff, clock, { async beforeWrite(filter, update) {
    if (!delayed && update.$set.occupancyStatus === 'Vacant') { delayed = true; entered.resolve(); await release.promise; }
  } });
  const checkout = response();
  const pending = rooms.checkoutRoom(request({ params: { id: reports[0]._id } }), checkout);
  await entered.promise;
  const checkin = response();
  await rooms.updateStatus(request({ params: { id: reports[0]._id }, body: { occupancyStatus: 'Occupied', guestStatus: 'Checked-in', notes: 'New guest arrived' } }), checkin);
  assert.equal(checkin.body.warning, undefined);
  release.resolve();
  await pending;
  assert.equal(checkout.statusCode, 200);
  assert.match(checkout.body.warning, /synchronization failed/);
  for (const record of [reports[0], staff[0]]) {
    assert.equal(record.occupancyStatus, 'Occupied');
    assert.equal(record.guestStatus, 'Checked-in');
    assert.equal(record.checkedOutAt == null, true);
  }
});

test('a delayed housekeeping completion cannot overwrite a newer desk occupancy update', async t => {
  const { reports, staff, clock } = fixture();
  for (const record of [reports[0], staff[0]]) Object.assign(record, { occupancyStatus: 'Vacant', housekeepingStatus: 'Dirty' });
  const entered = deferred(), release = deferred();
  let delayed = false;
  memoryModel(t, Housekeeper, staff, clock);
  memoryModel(t, RoomReport, reports, clock, { async beforeWrite(filter, update) {
    if (!delayed && update.$set.housekeepingStatus === 'Clean') { delayed = true; entered.resolve(); await release.promise; }
  } });
  const completion = response();
  const pending = housekeeping.updateStatus(request({ params: { id: staff[0]._id }, user: { role: 'housekeeping' }, body: { housekeepingStatus: 'Clean' } }), completion);
  await entered.promise;
  const checkin = response();
  await rooms.updateStatus(request({ params: { id: reports[0]._id }, body: { occupancyStatus: 'Occupied', housekeepingStatus: 'Dirty', guestStatus: 'Checked-in' } }), checkin);
  assert.equal(checkin.body.warning, undefined);
  release.resolve();
  await pending;
  assert.equal(completion.statusCode, 200);
  assert.match(completion.body.warning, /synchronization failed/);
  for (const record of [reports[0], staff[0]]) {
    assert.equal(record.occupancyStatus, 'Occupied');
    assert.equal(record.housekeepingStatus, 'Dirty');
  }
});

test('newer conflicting destination progress is preserved before its own synchronization completes', async t => {
  const { reports, staff, clock } = fixture();
  Object.assign(reports[0], { occupancyStatus: 'Vacant', guestStatus: 'Checked-out', checkedOutAt: new Date('2026-10-10T11:30:00Z'), housekeepingStatus: 'Dirty' });
  Object.assign(staff[0], { occupancyStatus: 'Occupied', guestStatus: 'Checked-in', updatedAt: new Date('2026-10-10T13:00:00Z') });
  memoryModel(t, RoomReport, reports, clock);
  memoryModel(t, Housekeeper, staff, clock);
  const res = response();
  await rooms.checkoutRoom(request({ params: { id: reports[0]._id } }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.warning, /synchronization failed/);
  assert.equal(staff[0].occupancyStatus, 'Occupied');
  assert.equal(staff[0].guestStatus, 'Checked-in');
});

test('bulk housekeeping retains per-record synchronization warnings without hiding primary saves', async t => {
  const { reports, staff, clock } = fixture();
  for (const record of [reports[0], staff[0]]) Object.assign(record, { occupancyStatus: 'Vacant', housekeepingStatus: 'Dirty' });
  memoryModel(t, Housekeeper, staff, clock);
  memoryModel(t, RoomReport, reports, clock, { beforeWrite() { throw new Error('Injected desk synchronization failure'); } });
  const req = request({ user: { role: 'housekeeping' }, body: { updates: [{ id: staff[0]._id, data: { housekeepingStatus: 'Clean' } }] } });
  const res = response();
  await housekeeping.bulkUpdateStatus(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.successCount, 1);
  assert.equal(res.body.errorCount, 0);
  assert.equal(res.body.warnings[0].id, staff[0]._id);
  assert.match(res.body.warnings[0].warning, /front desk synchronization failed/);
  assert.deepEqual(req.events.at(-1)[1].warnings, res.body.warnings);
  assert.equal(staff[0].housekeepingStatus, 'Clean');
  assert.equal(reports[0].housekeepingStatus, 'Dirty');
});

test('expectedUpdatedAt rejects invalid timestamps before any record read', async t => {
  t.mock.method(RoomReport, 'findById', () => assert.fail('Invalid guards cannot read or mutate rooms'));
  t.mock.method(Housekeeper, 'findById', () => assert.fail('Invalid guards cannot read or mutate housekeeping'));
  for (const timestamp of [null, 123, '2026-10-10', 'not a date', '2026-02-30T12:00:00Z']) {
    assert.throws(() => expectedVersion({ expectedUpdatedAt: timestamp }), error => error.status === 400);
    const checkout = response();
    await rooms.checkoutRoom(request({ params: { id: id() }, body: { expectedUpdatedAt: timestamp } }), checkout);
    assert.equal(checkout.statusCode, 400);
    const clean = response();
    await housekeeping.updateStatus(request({ params: { id: id() }, user: { role: 'housekeeping' }, body: { housekeepingStatus: 'Clean', expectedUpdatedAt: timestamp } }), clean);
    assert.equal(clean.statusCode, 400);
  }
});

test('a checkout drafted for a previous guest is rejected even when the current room is occupied', async t => {
  const { reports, staff, clock } = fixture();
  const oldVersion = reports[0].updatedAt.toISOString();
  Object.assign(reports[0], { guestStatus: 'Checked-in', checkIn: '2026-10-10', updatedAt: clock() });
  memoryModel(t, RoomReport, reports, clock);
  memoryModel(t, Housekeeper, staff, clock);
  const res = response();
  await rooms.checkoutRoom(request({ params: { id: reports[0]._id }, body: { expectedUpdatedAt: oldVersion } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(reports[0].occupancyStatus, 'Occupied');
  assert.equal(reports[0].checkedOutAt, undefined);
});

test('a stale stayover undo cannot erase a newer completion and its guard is not stored', async t => {
  const { reports, staff, clock } = fixture();
  const oldVersion = staff[0].updatedAt.toISOString();
  const service = new Date('2026-10-10T12:30:00Z');
  for (const record of [reports[0], staff[0]]) Object.assign(record, { guestStatus: 'Stay Over', checkOut: '2026-10-11', stayoverServicedAt: service, updatedAt: clock() });
  memoryModel(t, Housekeeper, staff, clock);
  memoryModel(t, RoomReport, reports, clock);
  const stale = response();
  await housekeeping.updateStatus(request({ params: { id: staff[0]._id }, user: { role: 'housekeeping' }, body: { stayoverServicedAt: null, expectedUpdatedAt: oldVersion } }), stale);
  assert.equal(stale.statusCode, 409);
  assert.equal(staff[0].stayoverServicedAt.getTime(), service.getTime());
  const current = response();
  await housekeeping.updateStatus(request({ params: { id: staff[0]._id }, user: { role: 'housekeeping' }, body: { stayoverServicedAt: null, expectedUpdatedAt: staff[0].updatedAt.toISOString() } }), current);
  assert.equal(current.statusCode, 200);
  assert.equal(staff[0].stayoverServicedAt, null);
  assert.equal(staff[0].expectedUpdatedAt, undefined);
});

test('guarded room edits reject stale versions and an idempotent Clean repair retains cleanedAt', async t => {
  const { reports, staff, clock } = fixture();
  for (const record of [reports[0], staff[0]]) record.occupancyStatus = 'Vacant';
  const cleanedAt = staff[0].cleanedAt.getTime();
  memoryModel(t, RoomReport, reports, clock);
  memoryModel(t, Housekeeper, staff, clock);
  const stale = response();
  await rooms.updateStatus(request({ params: { id: reports[0]._id }, body: { notes: 'Old draft', expectedUpdatedAt: '2026-10-10T09:00:00Z' } }), stale);
  assert.equal(stale.statusCode, 409);
  assert.equal(reports[0].notes, undefined);
  const repair = response();
  await housekeeping.updateStatus(request({ params: { id: staff[0]._id }, user: { role: 'housekeeping' }, body: { housekeepingStatus: 'Clean', expectedUpdatedAt: staff[0].updatedAt.toISOString() } }), repair);
  assert.equal(repair.statusCode, 200);
  assert.equal(staff[0].cleanedAt.getTime(), cleanedAt);
  assert.equal(repair.body.warning, undefined);
});

test('a queued service request for a previous stay cannot service the replacement guest', async t => {
  const { reports, staff, clock } = fixture();
  const oldVersion = staff[0].updatedAt.toISOString();
  for (const record of [reports[0], staff[0]]) Object.assign(record, { guestStatus: 'Stay Over', checkIn: '2026-10-10', checkOut: '2026-10-12', updatedAt: clock() });
  memoryModel(t, Housekeeper, staff, clock);
  memoryModel(t, RoomReport, reports, clock);
  const res = response();
  await housekeeping.updateStatus(request({ params: { id: staff[0]._id }, user: { role: 'housekeeping' }, body: { stayoverServicedAt: '2026-10-10T13:00:00Z', expectedUpdatedAt: oldVersion } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(staff[0].stayoverServicedAt, undefined);
  assert.equal(reports[0].stayoverServicedAt, undefined);
});

test('bulk housekeeping validates each expected version before any primary mutation', async t => {
  const { reports, staff, clock } = fixture();
  for (const record of [reports[0], staff[0]]) Object.assign(record, { occupancyStatus: 'Vacant', housekeepingStatus: 'Dirty' });
  memoryModel(t, Housekeeper, staff, clock);
  memoryModel(t, RoomReport, reports, clock);
  const res = response();
  await housekeeping.bulkUpdateStatus(request({ user: { role: 'housekeeping' }, body: { updates: [{ id: staff[0]._id, data: { housekeepingStatus: 'Clean', expectedUpdatedAt: '2026-10-10T09:00:00Z' } }] } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.successCount, 0);
  assert.equal(res.body.errorCount, 1);
  assert.match(res.body.errors[0].error, /changed/);
  assert.equal(staff[0].housekeepingStatus, 'Dirty');
});

test('persistent destination contention produces a warning after bounded retries', async t => {
  const { reports, staff, clock } = fixture();
  memoryModel(t, RoomReport, reports, clock);
  memoryModel(t, Housekeeper, staff, clock);
  let attempts = 0;
  t.mock.method(Housekeeper, 'findOneAndUpdate', async () => { attempts += 1; return null; });
  const res = response();
  await rooms.checkoutRoom(request({ params: { id: reports[0]._id } }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.warning, /synchronization failed/);
  assert.equal(attempts, 3);
  assert.equal(staff[0].occupancyStatus, 'Occupied');
  assert.equal(reports[0].occupancyStatus, 'Vacant');
});

test('checkout retry creates a missing housekeeping record as dirty when no matching-cycle cleaning exists', async t => {
  const { reports, staff, clock } = fixture();
  Object.assign(reports[0], { occupancyStatus: 'Vacant', guestStatus: 'Checked-out', checkedOutAt: new Date('2026-10-10T11:30:00Z') });
  staff.length = 0;
  memoryModel(t, RoomReport, reports, clock);
  memoryModel(t, Housekeeper, staff, clock);
  const res = response();
  await rooms.checkoutRoom(request({ params: { id: reports[0]._id } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.warning, undefined);
  assert.equal(staff.length, 1);
  assert.equal(staff[0].housekeepingStatus, 'Dirty');
  assert.equal(staff[0].cleanedAt, null);
  assert.equal(staff[0].checkedOutAt.getTime(), reports[0].checkedOutAt.getTime());
});

test('concurrent checkout repairs create one missing housekeeping record with a stable identity', async t => {
  const { reports, staff, clock } = fixture();
  Object.assign(reports[0], { occupancyStatus: 'Vacant', guestStatus: 'Checked-out', checkedOutAt: new Date('2026-10-10T11:30:00Z'), housekeepingStatus: 'Dirty' });
  staff.length = 0;
  memoryModel(t, RoomReport, reports, clock);
  memoryModel(t, Housekeeper, staff, clock);
  const first = response(), second = response();
  await Promise.all([
    rooms.checkoutRoom(request({ params: { id: reports[0]._id } }), first),
    rooms.checkoutRoom(request({ params: { id: reports[0]._id } }), second)
  ]);
  assert.equal(first.body.warning, undefined);
  assert.equal(second.body.warning, undefined);
  assert.equal(staff.length, 1);
  assert.equal(staff[0]._id, reports[0]._id);
  assert.equal(staff[0].housekeepingStatus, 'Dirty');
});

test('an idempotent desk Clean replay also retains the original housekeeping cleaning time', async t => {
  const { reports, staff, clock } = fixture();
  for (const record of [reports[0], staff[0]]) record.occupancyStatus = 'Vacant';
  const cleanedAt = staff[0].cleanedAt.getTime();
  memoryModel(t, RoomReport, reports, clock);
  memoryModel(t, Housekeeper, staff, clock);
  const res = response();
  await rooms.updateStatus(request({ params: { id: reports[0]._id }, body: { housekeepingStatus: 'Clean', expectedUpdatedAt: reports[0].updatedAt.toISOString() } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.warning, undefined);
  assert.equal(staff[0].cleanedAt.getTime(), cleanedAt);
});

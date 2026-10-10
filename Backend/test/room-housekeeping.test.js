const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const RoomReport = require('../src/models/RoomReport');
const Housekeeper = require('../src/models/Housekeeper');
const rooms = require('../src/controllers/roomController');
const housekeeping = require('../src/controllers/housekeeperController');
const { syncReportMetadata } = require('../src/utils/housekeepingSync');
const { parseReportDate, dateRange, normalizeFields, normalizeHousekeepingStatus, normalizeOccupancyStatus, isRoomUnavailable } = require('../src/utils/roomData');
const { normalizedStayDate, isStayover } = require('../src/utils/stayover');

function response() {
  return { statusCode: 200, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}
function request(overrides = {}) {
  const events = [];
  return { params: {}, query: {}, body: {}, user: { role: 'admin' }, app: { get() { return { emit: (...event) => events.push(event) }; } }, events, ...overrides };
}
const query = data => ({ sort: async () => data, then: resolve => Promise.resolve(data).then(resolve) });

test('report dates reject rolled-over and ambiguous dates and use a UTC-only day range', () => {
  assert.equal(parseReportDate('2024-02-29').toISOString(), '2024-02-29T00:00:00.000Z');
  for (const value of ['2026-02-29', '2026-02-30', '2026-13-01', '10/03/2026', '2026-10-03T10:00:00Z', undefined]) {
    assert.throws(() => parseReportDate(value), error => error.status === 400);
  }
  const range = dateRange('2026-10-03');
  assert.equal(range.$gte.toISOString(), '2026-10-03T00:00:00.000Z');
  assert.equal(range.$lt.toISOString(), '2026-10-04T00:00:00.000Z');
});

test('statuses are normalized, legacy booleans become strings, and contradictory flags fail', () => {
  assert.equal(normalizeHousekeepingStatus('out-of-order'), 'Out of Order');
  assert.equal(normalizeOccupancyStatus(' occupied '), 'Occupied');
  assert.throws(() => normalizeHousekeepingStatus('maybe'), error => error.status === 400);
  const record = normalizeFields({ room: 101, clean: true, dirty: false, occupied: false, vacant: true }, { housekeeping: true, imported: true, reportDate: '2026-10-03' });
  assert.equal(record.roomNumber, '101');
  assert.equal(record.housekeepingStatus, 'Clean');
  assert.equal(record.occupancyStatus, 'Vacant');
  assert.equal(record.clean, undefined);
  assert.throws(() => normalizeFields({ room: 101, clean: true, dirty: true }, { housekeeping: true, imported: true, reportDate: '2026-10-03' }));
  assert.throws(() => normalizeFields({ room: 101, clean: 'false' }, { housekeeping: true, imported: true, reportDate: '2026-10-03' }));
  assert.throws(() => normalizeFields({ room: 101, clean: false, housekeepingStatus: 'Clean' }, { housekeeping: true, imported: true, reportDate: '2026-10-03' }));
});

test('updates reject operators, immutable identity, and fields outside the housekeeping role', () => {
  for (const body of [{ $unset: { notes: 1 } }, { reportDate: '2026-10-04' }, { room: '999' }, { occupancyStatus: 'Vacant' }]) {
    assert.throws(() => normalizeFields(body, { partial: true, role: 'housekeeping' }), error => error.status === 400);
  }
  assert.deepEqual(normalizeFields({ housekeepingStatus: 'clean', notes: ' Done ' }, { partial: true, role: 'housekeeping' }), { housekeepingStatus: 'Clean', notes: 'Done' });
  assert.throws(() => normalizeFields({ pet: 'false' }, { partial: true }), error => error.status === 400);
});

test('room creation requires the actual room/reportDate schema, not obsolete number fields', async () => {
  await assert.rejects(new RoomReport({ number: '101', status: 'Clean' }).validate());
  await new RoomReport({ room: '101', reportDate: parseReportDate('2026-10-03') }).validate();
  await assert.rejects(new Housekeeper({ roomNumber: '101' }).validate());
});

test('invalid day requests fail before touching the database', async t => {
  let reads = 0;
  t.mock.method(RoomReport, 'find', () => { reads++; return query([]); });
  const res = response();
  await rooms.getRoomsByDate(request({ params: { date: '2026-02-30' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(reads, 0);
});

test('empty selected-day reads return an empty success response and do not broadcast', async t => {
  let filter;
  t.mock.method(Housekeeper, 'find', value => { filter = value; return query([]); });
  const req = request({ params: { date: '2026-10-03' } });
  const res = response();
  await housekeeping.getHousekeepingByDate(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, count: 0, date: '2026-10-03', data: [] });
  assert.deepEqual(Object.keys(filter), ['reportDate']);
  assert.equal(req.events.length, 0);
});

test('an invalid import batch cannot mutate or erase existing housekeeping records', async t => {
  let writes = 0;
  t.mock.method(Housekeeper, 'bulkWrite', () => { writes++; });
  t.mock.method(Housekeeper, 'deleteMany', () => { throw new Error('Import must never delete records'); });
  const req = request({ body: { date: '2026-10-03', rooms: [{ room: '101', housekeepingStatus: 'Clean' }, { room: '102', housekeepingStatus: 'unknown' }] } });
  const res = response();
  await housekeeping.importHousekeepingArray(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(writes, 0);
  assert.equal(req.events.length, 0);
});

test('reimport only upserts the selected date and preserves existing staff progress', async t => {
  const stored = [
    { _id: 'first', roomNumber: '101', reportDate: new Date('2026-10-03'), housekeepingStatus: 'Clean', notes: 'Inspected', assignedAttendant: 'Sam', cleanedAt: new Date('2026-10-03T12:00:00Z'), stayoverServicedAt: new Date('2026-10-03T13:00:00Z') },
    { _id: 'other-day', roomNumber: '101', reportDate: new Date('2026-10-02'), housekeepingStatus: 'Dirty', notes: 'Yesterday' }
  ];
  const matches = (record, filter) => (!filter.roomNumber || filter.roomNumber === record.roomNumber) && record.reportDate >= filter.reportDate.$gte && record.reportDate < filter.reportDate.$lt;
  t.mock.method(Housekeeper, 'find', filter => query(stored.filter(record => matches(record, filter))));
  t.mock.method(Housekeeper, 'deleteMany', () => { throw new Error('Import must never delete records'); });
  t.mock.method(Housekeeper, 'bulkWrite', async operations => {
    for (const operation of operations) {
      const update = operation.updateOne || operation.updateMany;
      assert.equal(update.update.$set.housekeepingStatus, undefined);
      assert.equal(update.update.$set.notes, undefined);
      assert.equal(update.update.$set.stayoverServicedAt, undefined);
      if (operation.updateOne) assert.equal(update.update.$setOnInsert.stayoverServicedAt, undefined);
      if (operation.updateOne) assert.equal(update.update.$setOnInsert.housekeepingStatus, 'Dirty');
      const current = stored.find(record => matches(record, update.filter) && (!Object.hasOwn(update.filter, 'checkedOutAt') || record.checkedOutAt == null));
      if (current) Object.assign(current, update.update.$set);
      else if (update.upsert) stored.push({ _id: new mongoose.Types.ObjectId().toString(), ...update.update.$setOnInsert, ...update.update.$set });
    }
    return { upsertedCount: 0, modifiedCount: operations.length };
  });
  const req = request({ body: { date: '2026-10-03', rooms: [{ room: '101', housekeepingStatus: 'Dirty', notes: 'Source note', occupancyStatus: 'Occupied', pet: true, stayoverServicedAt: '2026-10-03T16:00:00Z' }] } });
  const res = response();
  await housekeeping.importHousekeepingArray(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.preservedCount, 1);
  assert.equal(stored[0].housekeepingStatus, 'Clean');
  assert.equal(stored[0].notes, 'Inspected');
  assert.equal(stored[0].assignedAttendant, 'Sam');
  assert.equal(stored[0].stayoverServicedAt.toISOString(), '2026-10-03T13:00:00.000Z');
  assert.equal(stored[0].occupancyStatus, 'Occupied');
  assert.equal(stored[1].notes, 'Yesterday');
  assert.equal(stored[1].housekeepingStatus, 'Dirty');
  assert.equal(req.events.length, 1);
});

test('GET lists never trigger socket broadcasts', async t => {
  t.mock.method(Housekeeper, 'find', () => query([{ roomNumber: '101' }]));
  const req = request();
  const res = response();
  await housekeeping.listHousekeeping(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(req.events.length, 0);
});

test('report order codes keep clean rooms unavailable and outside available-clean totals', async t => {
  for (const orderStatus of ['OOI/OI', 'OOO', 'Out of Inventory', 'Out of Order', 'OOS']) {
    assert.equal(isRoomUnavailable({ housekeepingStatus: 'Clean', orderStatus }), true);
  }
  t.mock.method(Housekeeper, 'find', () => query([
    { housekeepingStatus: 'Clean', occupancyStatus: 'Vacant', orderStatus: 'OOI/OI' },
    { housekeepingStatus: 'Clean', occupancyStatus: 'Vacant', orderStatus: '' }
  ]));
  const res = response();
  await housekeeping.getHousekeepingSummary(request({ query: { date: '2026-10-03' } }), res);
  assert.equal(res.body.summary.cleanRooms, 1);
  assert.equal(res.body.summary.outOfOrderRooms, 1);
  assert.equal(res.body.summary.unavailableRooms, 1);
});

test('cleaning staff cannot reopen an order-blocked room through a status update', async t => {
  let writes = 0;
  t.mock.method(Housekeeper, 'findById', async () => ({ housekeepingStatus: 'Clean', orderStatus: 'OOI/OI' }));
  t.mock.method(Housekeeper, 'findByIdAndUpdate', async () => { writes++; });
  const res = response();
  await housekeeping.updateStatus(request({ params: { id: new mongoose.Types.ObjectId().toString() }, user: { role: 'housekeeping' }, body: { housekeepingStatus: 'Dirty' } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(writes, 0);
});

test('housekeeping cannot finish an occupied room through either update API', async t => {
  let writes = 0;
  const occupied = { housekeepingStatus: 'Dirty', occupancyStatus: 'Occupied' };
  t.mock.method(Housekeeper, 'findById', async () => occupied);
  t.mock.method(RoomReport, 'findById', async () => occupied);
  t.mock.method(Housekeeper, 'findByIdAndUpdate', async () => { writes++; });
  t.mock.method(RoomReport, 'findByIdAndUpdate', async () => { writes++; });
  for (const controller of [housekeeping.updateStatus, rooms.updateStatus]) {
    const req = request({ params: { id: new mongoose.Types.ObjectId().toString() }, user: { role: 'housekeeping' }, body: { housekeepingStatus: 'Clean' } });
    const res = response();
    await controller(req, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /checked out/i);
    assert.equal(req.events.length, 0);
  }
  assert.equal(writes, 0);
});

test('front desk checkout releases a dated room for cleaning and broadcasts both boards', async t => {
  const id = new mongoose.Types.ObjectId().toString();
  const record = { _id: id, room: '101', reportDate: new Date('2026-10-03T12:00:00Z'), housekeepingStatus: 'Clean', occupancyStatus: 'Occupied', notes: 'Pet In Room', stayoverServicedAt: new Date('2026-10-03T10:00:00Z') };
  t.mock.method(RoomReport, 'findById', async () => record);
  t.mock.method(RoomReport, 'findOneAndUpdate', async (filter, update, options) => {
    assert.deepEqual(filter, { _id: id, occupancyStatus: 'Occupied', checkedOutAt: null, updatedAt: null });
    assert.equal(options.runValidators, true);
    Object.assign(record, update.$set);
    return record;
  });
  let synchronized;
  let mirror;
  t.mock.method(Housekeeper, 'find', filter => {
    assert.equal(filter.roomNumber, '101');
    assert.equal(filter.reportDate.$gte.toISOString(), '2026-10-03T00:00:00.000Z');
    assert.equal(filter.reportDate.$lt.toISOString(), '2026-10-04T00:00:00.000Z');
    return query(mirror ? [mirror] : []);
  });
  t.mock.method(Housekeeper, 'updateOne', async (filter, update, options) => {
    assert.equal(options.upsert, true);
    synchronized = update.$setOnInsert;
    mirror = { _id: new mongoose.Types.ObjectId(), ...synchronized };
    return { upsertedCount: 1 };
  });
  const req = request({ params: { id }, user: { role: 'frontdesk' } });
  const res = response();
  await rooms.checkoutRoom(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.occupancyStatus, 'Vacant');
  assert.equal(res.body.data.housekeepingStatus, 'Dirty');
  assert.equal(res.body.data.guestStatus, 'Checked-out');
  assert.equal(res.body.data.stayoverServicedAt, null);
  assert.ok(res.body.data.checkedOutAt instanceof Date);
  assert.equal(synchronized.cleanedAt, null);
  assert.equal(synchronized.inspectedAt, null);
  assert.equal(synchronized.stayoverServicedAt, null);
  assert.equal(synchronized.notes, 'Pet In Room');
  assert.deepEqual(req.events.map(([event, payload]) => [event, payload.action, payload.date]), [
    ['housekeepingBulkUpdated', 'checkout', '2026-10-03'], ['roomStatusUpdated', 'checkout', '2026-10-03']
  ]);
});

test('checkout denies housekeeping before database access and never dirties a vacant clean room', async t => {
  let reads = 0, writes = 0;
  const record = { room: '101', reportDate: new Date('2026-10-03'), housekeepingStatus: 'Clean', occupancyStatus: 'Vacant' };
  t.mock.method(RoomReport, 'findById', async () => { reads++; return record; });
  t.mock.method(RoomReport, 'findOneAndUpdate', async () => { writes++; });
  const forbidden = response();
  await rooms.checkoutRoom(request({ params: { id: new mongoose.Types.ObjectId().toString() }, user: { role: 'housekeeping' } }), forbidden);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(reads, 0);
  const vacant = response();
  await rooms.checkoutRoom(request({ params: { id: new mongoose.Types.ObjectId().toString() }, user: { role: 'frontdesk' } }), vacant);
  assert.equal(vacant.statusCode, 409);
  assert.equal(record.housekeepingStatus, 'Clean');
  assert.equal(writes, 0);
});

test('checkout retry preserves completed cleaning only for a matching checkout cycle', async t => {
  const id = new mongoose.Types.ObjectId().toString();
  const checkedOutAt = new Date('2026-10-03T12:00:00Z');
  const cleanedAt = new Date('2026-10-03T14:00:00Z');
  const record = { _id: id, room: '101', reportDate: new Date('2026-10-03'), housekeepingStatus: 'Clean', occupancyStatus: 'Vacant', guestStatus: 'Checked-out', checkedOutAt };
  const mirror = { ...record, _id: new mongoose.Types.ObjectId(), roomNumber: '101', cleanedAt };
  t.mock.method(RoomReport, 'findById', async () => record);
  t.mock.method(RoomReport, 'findOneAndUpdate', () => assert.fail('A repeated checkout must not mutate the room report'));
  t.mock.method(Housekeeper, 'find', () => query([mirror]));
  t.mock.method(Housekeeper, 'findOneAndUpdate', () => assert.fail('Matching checkout progress must remain untouched'));
  const req = request({ params: { id }, user: { role: 'frontdesk' } });
  const res = response();
  await rooms.checkoutRoom(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.warning, undefined);
  assert.equal(mirror.housekeepingStatus, 'Clean');
  assert.equal(mirror.cleanedAt, cleanedAt);
  assert.equal(req.events.length, 1);
});

test('checkout preserves unavailable status and order instead of releasing a blocked room', async t => {
  let record;
  let mirror;
  t.mock.method(RoomReport, 'findById', async () => record);
  t.mock.method(RoomReport, 'findOneAndUpdate', async (filter, update) => Object.assign(record, update.$set));
  t.mock.method(Housekeeper, 'find', () => query(mirror ? [mirror] : []));
  t.mock.method(Housekeeper, 'updateOne', async (filter, update) => { mirror = { _id: new mongoose.Types.ObjectId(), ...update.$setOnInsert }; return { upsertedCount: 1 }; });
  for (const blocked of [
    { housekeepingStatus: 'Out of Order', orderStatus: '' },
    { housekeepingStatus: 'Maintenance', orderStatus: '' },
    { housekeepingStatus: 'Clean', orderStatus: 'OOI/OI' }
  ]) {
    mirror = null;
    const id = new mongoose.Types.ObjectId().toString();
    record = { _id: id, room: '101', reportDate: new Date('2026-10-03'), occupancyStatus: 'Occupied', ...blocked };
    const res = response();
    await rooms.checkoutRoom(request({ params: { id }, user: { role: 'frontdesk' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.occupancyStatus, 'Vacant');
    assert.equal(res.body.data.housekeepingStatus, blocked.housekeepingStatus);
    assert.equal(res.body.data.orderStatus, blocked.orderStatus);
    assert.equal(isRoomUnavailable(res.body.data), true);
  }
});

test('vacant-room completion reaches the front desk with the same report date', async t => {
  const id = new mongoose.Types.ObjectId().toString();
  const record = { _id: id, roomNumber: '101', reportDate: new Date('2026-10-03'), housekeepingStatus: 'Dirty', occupancyStatus: 'Vacant' };
  t.mock.method(Housekeeper, 'findById', async () => record);
  t.mock.method(Housekeeper, 'findOneAndUpdate', async (filter, update) => {
    assert.deepEqual(filter, { _id: id, updatedAt: null });
    return Object.assign(record, update.$set);
  });
  let mirror = { _id: new mongoose.Types.ObjectId(), room: '101', reportDate: record.reportDate, housekeepingStatus: 'Dirty', occupancyStatus: 'Vacant' };
  t.mock.method(RoomReport, 'find', filter => {
    assert.equal(filter.room, '101');
    assert.equal(filter.reportDate.$gte.toISOString(), '2026-10-03T00:00:00.000Z');
    return query([mirror]);
  });
  t.mock.method(RoomReport, 'findOneAndUpdate', async (filter, update) => {
    assert.equal(String(filter._id), String(mirror._id));
    assert.deepEqual(update.$set, { housekeepingStatus: 'Clean' });
    mirror = { ...mirror, ...update.$set };
    return mirror;
  });
  const req = request({ params: { id }, user: { role: 'housekeeping' }, body: { housekeepingStatus: 'Clean' } });
  const res = response();
  await housekeeping.updateStatus(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.data.cleanedAt instanceof Date);
  assert.deepEqual(req.events.map(([event, payload]) => [event, payload.date]), [
    ['roomStatusUpdated', '2026-10-03'], ['housekeepingStatusUpdated', '2026-10-03']
  ]);
});

test('upload synchronization creates missing dated rooms while preserving staff work on existing rooms', async t => {
  const day = '2026-10-03';
  const stored = [{ roomNumber: '101', reportDate: new Date(day), housekeepingStatus: 'Clean', notes: 'Finished by Sam', cleanedAt: new Date('2026-10-03T12:00:00Z') }];
  t.mock.method(Housekeeper, 'bulkWrite', async operations => {
    let created = 0;
    for (const operation of operations) {
      const update = operation.updateOne || operation.updateMany;
      assert.equal(update.upsert, Boolean(operation.updateOne));
      assert.equal(update.filter.reportDate.$gte.toISOString(), `${day}T00:00:00.000Z`);
      assert.equal(update.update.$set.housekeepingStatus, undefined);
      assert.equal(update.update.$set.notes, undefined);
      const record = stored.find(row => row.roomNumber === update.filter.roomNumber && (!Object.hasOwn(update.filter, 'checkedOutAt') || row.checkedOutAt == null));
      if (record) Object.assign(record, update.update.$set);
      else if (update.upsert) { stored.push({ ...update.update.$setOnInsert, ...update.update.$set }); created++; }
    }
    return { modifiedCount: operations.length - created, upsertedCount: created };
  });
  const rows = [
    { room: '101', occupancyStatus: 'Vacant', housekeepingStatus: 'Dirty', notes: 'Old source note' },
    { room: '102', occupancyStatus: 'Occupied', housekeepingStatus: 'Dirty', notes: 'Pet In Room' }
  ];
  const first = await syncReportMetadata(rows, day, { ensureRecords: true });
  assert.equal(first.upsertedCount, 1);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].housekeepingStatus, 'Clean');
  assert.equal(stored[0].notes, 'Finished by Sam');
  assert.ok(stored[0].cleanedAt);
  assert.equal(stored[1].occupancyStatus, 'Occupied');
  assert.equal(stored[1].notes, 'Pet In Room');
  assert.equal(stored[1].reportDate.toISOString(), `${day}T00:00:00.000Z`);
  assert.equal((await syncReportMetadata(rows, day, { ensureRecords: true })).upsertedCount, 0);
  assert.equal(stored.length, 2);
});

test('stayover service eligibility distinguishes continuing stays from departures and uncertain occupancy', () => {
  const record = { occupancyStatus: 'Occupied', housekeepingStatus: 'Dirty', reportDate: new Date('2026-10-03'), checkOut: '2026-10-04' };
  assert.equal(isStayover(record), true);
  for (const changes of [
    { checkOut: '2026-10-03', guestStatus: 'Stay Over' }, { checkOut: '2026-10-02' },
    { guestStatus: 'Due-out' }, { guestStatus: 'due out' }, { guestStatus: 'Checked-out' },
    { checkOut: null }, { checkOut: 'Unknown', guestStatus: 'Checked-in' },
    { occupancyStatus: 'Vacant', guestStatus: 'Stay Over' },
    { housekeepingStatus: 'Maintenance' }, { orderStatus: 'OOI/OI' }, { reportDate: null }
  ]) assert.equal(isStayover({ ...record, ...changes }), false, JSON.stringify(changes));
  assert.equal(isStayover({ ...record, checkOut: null, guestStatus: 'Stay Over' }), true);
  assert.equal(isStayover({ ...record, checkOut: 'Unknown', guestStatus: 'Stayover' }), true);
  assert.equal(isStayover({ ...record, checkOut: 'Oct 04' }), true);
  assert.equal(isStayover({ ...record, checkOut: '10/04' }), true);
  assert.equal(normalizedStayDate('Jan 02', '2025-12-31'), '2025-01-02');
  assert.equal(normalizedStayDate('10/04/26', '2026-10-03'), '2026-10-04');
  assert.equal(normalizedStayDate('Feb 30', '2026-10-03'), '');
});

test('stayover timestamps are typed partial progress fields and cannot be forged by a new report', () => {
  const options = { housekeeping: true, partial: true, role: 'housekeeping' };
  const stamp = '2026-10-03T14:30:00.000Z';
  assert.deepEqual(normalizeFields({ stayoverServicedAt: stamp }, options), { stayoverServicedAt: new Date(stamp) });
  assert.deepEqual(normalizeFields({ stayoverServicedAt: null }, options), { stayoverServicedAt: null });
  for (const value of ['bad', 123, false, [], {}]) {
    assert.throws(() => normalizeFields({ stayoverServicedAt: value }, options), error => error.status === 400);
  }
  assert.throws(() => normalizeFields({ roomNumber: '101', reportDate: '2026-10-03', stayoverServicedAt: stamp }, { housekeeping: true }), /cannot be changed/);
  assert.throws(() => normalizeFields({ stayoverServicedAt: stamp }, { partial: true, role: 'housekeeping' }), /cannot be changed/);
  const imported = normalizeFields({ room: '101', stayoverServicedAt: stamp }, { housekeeping: true, imported: true, reportDate: '2026-10-03' });
  assert.equal(imported.stayoverServicedAt, undefined);
});

test('stayover service completion and undo preserve guest occupancy and cleaning status on both boards', async t => {
  const id = new mongoose.Types.ObjectId().toString();
  const cleanedAt = new Date('2026-10-02T12:00:00Z');
  const record = { _id: id, roomNumber: '101', reportDate: new Date('2026-10-03'), housekeepingStatus: 'Dirty', occupancyStatus: 'Occupied', guestStatus: 'Stay Over', checkOut: '2026-10-04', cleanedAt, updatedAt: new Date('2026-10-03T12:00:00Z') };
  t.mock.method(Housekeeper, 'findById', async () => record);
  t.mock.method(Housekeeper, 'findByIdAndUpdate', () => assert.fail('Stayover progress must check current eligibility and version'));
  t.mock.method(Housekeeper, 'findOneAndUpdate', async (filter, update, options) => {
    assert.deepEqual(filter, { _id: id, updatedAt: record.updatedAt });
    assert.equal(options.runValidators, true);
    assert.deepEqual(Object.keys(update.$set), ['stayoverServicedAt']);
    return Object.assign(record, update.$set);
  });
  let mirror = { ...record, _id: new mongoose.Types.ObjectId(), room: '101' };
  t.mock.method(RoomReport, 'find', filter => {
    assert.equal(filter.room, '101');
    assert.equal(filter.reportDate.$gte.toISOString(), '2026-10-03T00:00:00.000Z');
    return query([mirror]);
  });
  t.mock.method(RoomReport, 'findOneAndUpdate', async (filter, update) => {
    assert.equal(String(filter._id), String(mirror._id));
    assert.deepEqual(Object.keys(update.$set), ['stayoverServicedAt']);
    mirror = { ...mirror, ...update.$set };
    return mirror;
  });
  for (const stamp of ['2026-10-03T14:30:00.000Z', null]) {
    const req = request({ params: { id }, user: { role: 'housekeeping' }, body: { stayoverServicedAt: stamp } });
    const res = response();
    await housekeeping.updateStatus(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.stayoverServicedAt?.toISOString() ?? null, stamp);
    assert.equal(res.body.data.occupancyStatus, 'Occupied');
    assert.equal(res.body.data.housekeepingStatus, 'Dirty');
    assert.equal(res.body.data.cleanedAt, cleanedAt);
    assert.deepEqual(req.events.map(([event]) => event), ['roomStatusUpdated', 'housekeepingStatusUpdated']);
  }
});

test('stayover service and undo reject departures, unavailable rooms, and combined cleaning mutations before writing', async t => {
  const id = new mongoose.Types.ObjectId().toString();
  const base = { _id: id, roomNumber: '101', reportDate: new Date('2026-10-03'), housekeepingStatus: 'Dirty', occupancyStatus: 'Occupied', checkOut: '2026-10-04' };
  let record;
  t.mock.method(Housekeeper, 'findById', async () => record);
  t.mock.method(Housekeeper, 'findByIdAndUpdate', () => assert.fail('Invalid service mutation cannot write'));
  t.mock.method(Housekeeper, 'findOneAndUpdate', () => assert.fail('Invalid service mutation cannot write'));
  for (const role of ['housekeeping', 'admin']) for (const changes of [
    { checkOut: '2026-10-03', guestStatus: 'Stay Over' }, { checkOut: '2026-10-02' },
    { checkOut: null }, { guestStatus: 'Due-out' }, { occupancyStatus: 'Vacant' },
    { housekeepingStatus: 'Maintenance' }, { orderStatus: 'OOO' }
  ]) for (const stamp of ['2026-10-03T14:30:00.000Z', null]) {
    record = { ...base, ...changes };
    const req = request({ params: { id }, user: { role }, body: { stayoverServicedAt: stamp } });
    const res = response();
    await housekeeping.updateStatus(req, res);
    assert.equal(res.statusCode, 409, JSON.stringify({ role, changes, stamp }));
    assert.equal(req.events.length, 0);
  }
  record = base;
  for (const changes of [{ occupancyStatus: 'Vacant' }, { housekeepingStatus: 'Clean' }]) {
    const res = response();
    await housekeeping.updateStatus(request({ params: { id }, body: { stayoverServicedAt: '2026-10-03T14:30:00.000Z', ...changes } }), res);
    assert.equal(res.statusCode, 400);
  }
});

test('a concurrent room change rejects stale stayover progress without synchronizing it', async t => {
  const id = new mongoose.Types.ObjectId().toString();
  t.mock.method(Housekeeper, 'findById', async () => ({ _id: id, occupancyStatus: 'Occupied', housekeepingStatus: 'Dirty', reportDate: new Date('2026-10-03'), checkOut: '2026-10-04', updatedAt: new Date('2026-10-03T12:00:00Z') }));
  t.mock.method(Housekeeper, 'findOneAndUpdate', async () => null);
  t.mock.method(RoomReport, 'find', () => assert.fail('Stale progress must not synchronize'));
  const req = request({ params: { id }, user: { role: 'housekeeping' }, body: { stayoverServicedAt: '2026-10-03T14:30:00.000Z' } });
  const res = response();
  await housekeeping.updateStatus(req, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /changed/);
  assert.equal(req.events.length, 0);
});

test('front desk edits preserve stayover progress until occupancy changes', async t => {
  const id = new mongoose.Types.ObjectId().toString();
  const stamp = new Date('2026-10-03T14:30:00Z');
  const record = { _id: id, room: '101', reportDate: new Date('2026-10-03'), occupancyStatus: 'Occupied', housekeepingStatus: 'Dirty', stayoverServicedAt: stamp };
  t.mock.method(RoomReport, 'findById', async () => record);
  t.mock.method(RoomReport, 'findOneAndUpdate', async (filter, update) => Object.assign(record, update.$set));
  let mirror = { ...record, _id: new mongoose.Types.ObjectId(), roomNumber: '101' };
  t.mock.method(Housekeeper, 'find', () => query([mirror]));
  t.mock.method(Housekeeper, 'findOneAndUpdate', async (filter, update) => {
    assert.equal(String(filter._id), String(mirror._id));
    mirror = { ...mirror, ...update.$set };
    return mirror;
  });
  for (const occupancyStatus of ['Occupied', 'Vacant']) {
    const res = response();
    await rooms.updateStatus(request({ params: { id }, user: { role: 'frontdesk' }, body: { occupancyStatus, notes: 'Desk edit' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.stayoverServicedAt, occupancyStatus === 'Occupied' ? stamp : null);
    assert.equal(mirror.stayoverServicedAt, occupancyStatus === 'Occupied' ? stamp : null);
    assert.equal(res.body.warning, undefined);
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const RoomReport = require('../src/models/RoomReport');
const Housekeeper = require('../src/models/Housekeeper');
const rooms = require('../src/controllers/roomController');
const housekeeping = require('../src/controllers/housekeeperController');
const { syncReportMetadata } = require('../src/utils/housekeepingSync');

const response = () => ({ statusCode: 200, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });
const request = overrides => ({ query: {}, params: {}, body: {}, user: { role: 'admin' }, app: { get: () => ({ emit() {} }) }, ...overrides });
async function invoke(controller, overrides) {
  const res = response();
  await controller(request(overrides), res);
  assert.ok(res.statusCode < 400, JSON.stringify(res.body));
  return res.body;
}

test('Mongo import, reimport, bulk updates, and bidirectional room synchronization', { skip: !process.env.TEST_MONGO_URI }, async t => {
  // A unique database is created and removed by this test; configured application data is never opened.
  const database = `motel_qa_backend_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  t.after(async () => {
    try {
      if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    } finally {
      await mongoose.disconnect();
    }
  });
  await mongoose.connect(process.env.TEST_MONGO_URI, { dbName: database, serverSelectionTimeoutMS: 5000 });
  await Promise.all([RoomReport.init(), Housekeeper.init()]);
  const reports = await RoomReport.create([
    { room: '101', reportDate: new Date('2026-10-03T12:00:00Z'), housekeepingStatus: 'Dirty', occupancyStatus: 'Occupied', notes: null },
    { room: '102', reportDate: new Date('2026-10-03'), housekeepingStatus: 'Out of Order', occupancyStatus: 'Vacant' },
    { room: '101', reportDate: new Date('2026-10-02'), housekeepingStatus: 'Dirty' }
  ]);
  await invoke(housekeeping.importToHousekeeping, { body: { date: '2026-10-02' } });
  const first = await invoke(housekeeping.importToHousekeeping, { body: { date: '2026-10-03' } });
  assert.equal(first.createdCount, 2);
  assert.equal(await Housekeeper.countDocuments(), 3);
  const hk = await Housekeeper.findOne({ roomNumber: '101', reportDate: new Date('2026-10-03') });
  const changed = await invoke(housekeeping.updateStatus, { params: { id: hk.id }, body: { housekeepingStatus: 'Clean', notes: 'Inspected', assignedAttendant: 'Sam' } });
  assert.equal(changed.data.housekeepingStatus, 'Clean');
  assert.ok(changed.data.cleanedAt);
  assert.equal((await RoomReport.findById(reports[0].id)).housekeepingStatus, 'Clean');
  assert.equal((await RoomReport.findById(reports[2].id)).housekeepingStatus, 'Dirty');

  const second = await invoke(housekeeping.importToHousekeeping, { body: { date: '2026-10-03' } });
  assert.equal(second.createdCount, 0);
  assert.equal(second.preservedCount, 2);
  assert.equal(await Housekeeper.countDocuments(), 3);
  const retained = await Housekeeper.findById(hk.id);
  assert.equal(retained.housekeepingStatus, 'Clean');
  assert.equal(retained.notes, 'Inspected');
  assert.equal(retained.assignedAttendant, 'Sam');
  assert.ok(retained.cleanedAt);

  await invoke(rooms.updateStatus, { params: { id: reports[0].id }, user: { role: 'frontdesk' }, body: { housekeepingStatus: 'Dirty', pet: true } });
  const synced = await Housekeeper.findById(hk.id);
  assert.equal(synced.housekeepingStatus, 'Dirty');
  assert.equal(synced.cleanedAt, null);
  assert.equal(synced.pet, true);
  const checkout = await invoke(rooms.checkoutRoom, { params: { id: reports[0].id }, user: { role: 'frontdesk' } });
  assert.equal(checkout.data.occupancyStatus, 'Vacant');
  assert.equal(checkout.data.housekeepingStatus, 'Dirty');
  assert.ok(checkout.data.checkedOutAt);
  assert.equal((await Housekeeper.findById(hk.id)).occupancyStatus, 'Vacant');
  const bulk = await invoke(housekeeping.bulkUpdateStatus, { user: { role: 'housekeeping' }, body: { updates: [{ id: hk.id, data: { housekeepingStatus: 'Clean' } }, { id: 'invalid', data: { housekeepingStatus: 'Clean' } }] } });
  assert.equal(bulk.successCount, 1);
  assert.equal(bulk.errorCount, 1);
  assert.equal((await RoomReport.findById(reports[0].id)).housekeepingStatus, 'Clean');
  await invoke(rooms.checkoutRoom, { params: { id: reports[0].id }, user: { role: 'frontdesk' } });
  const afterRetry = await Housekeeper.findById(hk.id);
  assert.equal(afterRetry.housekeepingStatus, 'Clean');
  assert.ok(afterRetry.cleanedAt);
  const empty = await invoke(housekeeping.getHousekeepingByDate, { params: { date: '2026-10-01' } });
  assert.deepEqual(empty.data, []);

  await syncReportMetadata([
    { room: '101', occupancyStatus: 'Vacant', orderStatus: 'OOI/OI', housekeepingStatus: 'Dirty', notes: 'Reupload source', assignedAttendant: 'Other', pet: false },
    { room: '999', occupancyStatus: 'Vacant' }
  ], '2026-10-03');
  const refreshed = await Housekeeper.findById(hk.id);
  assert.equal(refreshed.housekeepingStatus, 'Clean');
  assert.equal(refreshed.notes, 'Inspected');
  assert.equal(refreshed.assignedAttendant, 'Sam');
  assert.equal(refreshed.occupancyStatus, 'Vacant');
  assert.equal(refreshed.orderStatus, 'OOI/OI');
  assert.equal(refreshed.pet, false);
  assert.equal(await Housekeeper.countDocuments(), 3);
  assert.equal((await Housekeeper.findOne({ roomNumber: '101', reportDate: new Date('2026-10-02') })).housekeepingStatus, 'Dirty');
});

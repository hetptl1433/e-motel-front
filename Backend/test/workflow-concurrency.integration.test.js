const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const RoomReport = require('../src/models/RoomReport');
const Housekeeper = require('../src/models/Housekeeper');
const roomController = require('../src/controllers/roomController');
const housekeepingController = require('../src/controllers/housekeeperController');
const { createUploadReport } = require('../src/controllers/reportController');
const { syncReportMetadata } = require('../src/utils/housekeepingSync');

const day = '2026-10-03';
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const request = overrides => {
  const events = [];
  return { params: {}, body: {}, user: { role: 'frontdesk' }, app: { get: () => ({ emit: (...event) => events.push(event) }) }, events, ...overrides };
};
const createRoom = (room, extra = {}) => RoomReport.create({ room, reportDate: new Date(day), housekeepingStatus: 'Dirty', occupancyStatus: 'Occupied', ...extra });

test('concurrent imports, checkout, and cleaning preserve the latest staff action in MongoDB', { skip: !process.env.TEST_MONGO_URI }, async t => {
  const database = `motel_qa_races_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'motel-concurrency-test-'));
  t.after(async () => {
    try {
      if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    } finally {
      try {
        await mongoose.disconnect();
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  });
  await mongoose.connect(process.env.TEST_MONGO_URI, { dbName: database, serverSelectionTimeoutMS: 5000 });
  await Promise.all([RoomReport.init(), Housekeeper.init()]);

  await t.test('checkout between an upload snapshot and bulk write is not reverted', async st => {
    const report = await createRoom('101');
    const originalWrite = RoomReport.bulkWrite.bind(RoomReport);
    let interleaved = false;
    st.mock.method(RoomReport, 'bulkWrite', async (...args) => {
      if (!interleaved) {
        interleaved = true;
        const checkout = response();
        await roomController.checkoutRoom(request({ params: { id: report.id } }), checkout);
        assert.equal(checkout.statusCode, 200);
      }
      return originalWrite(...args);
    });
    const filename = path.join(directory, 'morning.json');
    await fs.writeFile(filename, JSON.stringify([{ room: '101', occupancyStatus: 'Occupied', housekeepingStatus: 'Dirty', guestStatus: 'Due Out' }]));
    const res = response();
    await createUploadReport({ storageDirectory: directory })(request({ body: { reportDate: day }, file: { path: filename, originalname: 'morning.json' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data[0].occupancyStatus, 'Vacant');
    assert.equal(res.body.data[0].guestStatus, 'Checked-out');
    assert.ok(res.body.data[0].checkedOutAt);
    assert.equal((await Housekeeper.findOne({ roomNumber: '101' })).occupancyStatus, 'Vacant');
  });

  await t.test('an old housekeeping snapshot cannot reverse a completed checkout', async () => {
    const report = await createRoom('102');
    const snapshot = report.toObject();
    await syncReportMetadata([snapshot], day, { ensureRecords: true });
    const res = response();
    await roomController.checkoutRoom(request({ params: { id: report.id } }), res);
    assert.equal(res.statusCode, 200);
    await syncReportMetadata([snapshot], day, { ensureRecords: true });
    const saved = await Housekeeper.findOne({ roomNumber: '102' });
    assert.equal(saved.occupancyStatus, 'Vacant');
    assert.equal(saved.guestStatus, 'Checked-out');
    assert.ok(saved.checkedOutAt);
  });

  await t.test('re-upload repairs an older failed checkout sync but preserves a newer check-in', async () => {
    const marker = new Date(`${day}T12:00:00Z`);
    const report = await createRoom('103', { occupancyStatus: 'Vacant', guestStatus: 'Checked-out', checkedOutAt: marker });
    const snapshot = report.toObject();
    const older = new Date(snapshot.updatedAt.getTime() - 1000);
    const housekeeper = await Housekeeper.create({ roomNumber: '103', reportDate: new Date(day), occupancyStatus: 'Occupied', housekeepingStatus: 'Dirty' });
    await Housekeeper.updateOne({ _id: housekeeper.id }, { $set: { updatedAt: older } }, { timestamps: false });
    await syncReportMetadata([snapshot], day, { ensureRecords: true });
    const repaired = await Housekeeper.findById(housekeeper.id);
    assert.equal(repaired.occupancyStatus, 'Vacant');
    assert.equal(repaired.guestStatus, 'Checked-out');
    assert.equal(repaired.checkedOutAt.toISOString(), marker.toISOString());
    await Housekeeper.updateOne({ _id: housekeeper.id }, { $set: { occupancyStatus: 'Occupied', guestStatus: 'Checked-in', checkedOutAt: null, updatedAt: new Date(snapshot.updatedAt.getTime() + 1000) } }, { timestamps: false });
    await syncReportMetadata([snapshot], day, { ensureRecords: true });
    const newerStay = await Housekeeper.findById(housekeeper.id);
    assert.equal(newerStay.occupancyStatus, 'Occupied');
    assert.equal(newerStay.guestStatus, 'Checked-in');
    assert.equal(newerStay.checkedOutAt, null);
  });

  await t.test('single and bulk cleaning updates reject maintenance changed after availability was read', async st => {
    const report = await createRoom('104', { occupancyStatus: 'Vacant' });
    await syncReportMetadata([report.toObject()], day, { ensureRecords: true });
    const housekeeper = await Housekeeper.findOne({ roomNumber: '104' });
    const originalRead = Housekeeper.findById.bind(Housekeeper);
    let interleave = true;
    st.mock.method(Housekeeper, 'findById', async id => {
      const snapshot = await originalRead(id);
      if (interleave) {
        interleave = false;
        await Housekeeper.updateOne({ _id: id }, { $set: { housekeepingStatus: 'Maintenance', updatedAt: new Date(snapshot.updatedAt.getTime() + 1000) } }, { timestamps: false });
      }
      return snapshot;
    });
    const req = request({ params: { id: housekeeper.id }, user: { role: 'housekeeping' }, body: { housekeepingStatus: 'Clean' } });
    const res = response();
    await housekeepingController.updateStatus(req, res);
    assert.equal(res.statusCode, 409);
    assert.equal(req.events.length, 0);
    assert.equal((await originalRead(housekeeper.id)).housekeepingStatus, 'Maintenance');
    assert.equal((await RoomReport.findById(report.id)).housekeepingStatus, 'Dirty');
    await Housekeeper.updateOne({ _id: housekeeper.id }, { $set: { housekeepingStatus: 'Dirty' } });
    interleave = true;
    const bulk = response();
    await housekeepingController.bulkUpdateStatus(request({ user: { role: 'housekeeping' }, body: { updates: [{ id: housekeeper.id, data: { housekeepingStatus: 'Clean' } }] } }), bulk);
    assert.equal(bulk.body.successCount, 0);
    assert.equal(bulk.body.errorCount, 1);
    assert.match(bulk.body.errors[0].error, /room changed/i);
    assert.equal((await originalRead(housekeeper.id)).housekeepingStatus, 'Maintenance');
  });

  await t.test('room cleaning and checkout reject a newer maintenance edit', async st => {
    const report = await createRoom('105', { occupancyStatus: 'Vacant' });
    const originalRead = RoomReport.findById.bind(RoomReport);
    let interleave = true;
    st.mock.method(RoomReport, 'findById', async id => {
      const snapshot = await originalRead(id);
      if (interleave) {
        interleave = false;
        await RoomReport.updateOne({ _id: id }, { $set: { housekeepingStatus: 'Maintenance', updatedAt: new Date(snapshot.updatedAt.getTime() + 1000) } }, { timestamps: false });
      }
      return snapshot;
    });
    const clean = response();
    await roomController.updateStatus(request({ params: { id: report.id }, user: { role: 'housekeeping' }, body: { housekeepingStatus: 'Clean' } }), clean);
    assert.equal(clean.statusCode, 409);
    assert.equal((await originalRead(report.id)).housekeepingStatus, 'Maintenance');
    await RoomReport.updateOne({ _id: report.id }, { $set: { occupancyStatus: 'Occupied', housekeepingStatus: 'Dirty' } });
    interleave = true;
    const checkout = response();
    await roomController.checkoutRoom(request({ params: { id: report.id } }), checkout);
    assert.equal(checkout.statusCode, 409);
    const saved = await originalRead(report.id);
    assert.equal(saved.occupancyStatus, 'Occupied');
    assert.equal(saved.housekeepingStatus, 'Maintenance');
    assert.equal(saved.checkedOutAt, undefined);
  });

  await t.test('checkout retry cannot reset cleaning completed after its read', async st => {
    const report = await createRoom('106', { occupancyStatus: 'Vacant', checkedOutAt: new Date(`${day}T12:00:00Z`), guestStatus: 'Checked-out' });
    await syncReportMetadata([report.toObject()], day, { ensureRecords: true });
    const housekeeper = await Housekeeper.findOne({ roomNumber: '106' });
    const originalRead = RoomReport.findById.bind(RoomReport);
    let interleave = true;
    st.mock.method(RoomReport, 'findById', async id => {
      const snapshot = await originalRead(id);
      if (interleave) {
        interleave = false;
        const completion = response();
        await housekeepingController.updateStatus(request({ params: { id: housekeeper.id }, user: { role: 'housekeeping' }, body: { housekeepingStatus: 'Clean' } }), completion);
        assert.equal(completion.statusCode, 200);
      }
      return snapshot;
    });
    const res = response();
    await roomController.checkoutRoom(request({ params: { id: report.id } }), res);
    assert.equal(res.statusCode, 200);
    const saved = await Housekeeper.findById(housekeeper.id);
    assert.equal(saved.housekeepingStatus, 'Clean');
    assert.ok(saved.cleanedAt);
    assert.equal((await originalRead(report.id)).housekeepingStatus, 'Clean');
  });
});

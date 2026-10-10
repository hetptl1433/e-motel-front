const test = require('node:test');
const assert = require('node:assert/strict');
const Report = require('../src/models/RoomReport');
const { createUploadReport } = require('../src/controllers/reportController');
const { createRoomSheetHandlers } = require('../src/controllers/roomSheetController');
const { createMongoReportStorage } = require('../src/utils/reportStorage');
const { createMongoImportLocks, IMPORT_LEASE_MS } = require('../src/utils/reportImportLock');
const { VERCEL_REPORT_BYTES } = require('../src/utils/reportLimits');
const { createReportUpload } = require('../src/middleware/upload');
const { Readable } = require('stream');

const day = '2026-10-03';
function response() {
  return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, set(key, value) { if (typeof key === 'string') this.headers[key] = value; else Object.assign(this.headers, key); return this; }, send(value) { this.body = value; return this; } };
}

function memoryOriginalModel() {
  return class Originals {
    static rows = new Map();
    static selections = [];
    static async updateOne(filter, update, options) {
      assert.equal(options.upsert, true);
      assert.equal(options.runValidators, true);
      const old = this.rows.get(filter._id);
      this.rows.set(filter._id, { _id: filter._id, ...old, ...update.$set, data: Buffer.from(update.$set.data), createdAt: old?.createdAt || new Date('2026-10-03T12:00:00Z'), updatedAt: new Date('2026-10-03T13:00:00Z') });
      return { acknowledged: true };
    }
    static findOne(filter) {
      const Model = this;
      let selection;
      return {
        select(value) { selection = value; Model.selections.push(value); return this; },
        async lean() {
          const stored = Model.rows.get(filter._id);
          if (!stored) return null;
          const row = { ...stored };
          if (selection === '-data') delete row.data;
          return row;
        }
      };
    }
  };
}

function memoryLockModel() {
  return class Locks {
    static rows = new Map();
    static async findOneAndUpdate(filter, update, options) {
      assert.equal(options.upsert, true);
      assert.equal(options.new, true);
      const existing = this.rows.get(filter._id);
      if (existing && existing.expiresAt > filter.expiresAt.$lte) {
        const error = new Error('duplicate unique date'); error.code = 11000; throw error;
      }
      const row = { _id: filter._id, ...update.$set };
      this.rows.set(filter._id, row);
      return { ...row };
    }
    static async updateOne(filter, update) {
      const row = this.rows.get(filter._id);
      if (!row || row.ownerToken !== filter.ownerToken || row.expiresAt <= filter.expiresAt.$gt) return { matchedCount: 0 };
      Object.assign(row, update.$set);
      return { matchedCount: 1 };
    }
    static async deleteOne(filter) {
      const row = this.rows.get(filter._id);
      if (!row || row.ownerToken !== filter.ownerToken) return { deletedCount: 0 };
      this.rows.delete(filter._id);
      return { deletedCount: 1 };
    }
  };
}

function memoryReportModel() {
  return class MemoryReport {
    constructor(value) { this.value = value; }
    validate() { return new Report(this.value).validate(); }
    static rows = [];
    static writes = 0;
    static async bulkWrite(operations) {
      this.writes += 1;
      for (const { updateOne } of operations) {
        const old = this.rows.find(row => row.room === updateOne.filter.room && row.reportDate >= updateOne.filter.reportDate.$gte && row.reportDate < updateOne.filter.reportDate.$lt);
        if (old) Object.assign(old, updateOne.update.$set);
        else if (updateOne.upsert) this.rows.push({ _id: String(this.rows.length + 1), ...updateOne.update.$setOnInsert, ...updateOne.update.$set });
      }
    }
    static find(filter) {
      const rows = this.rows.filter(row => row.reportDate >= filter.reportDate.$gte && row.reportDate < filter.reportDate.$lt);
      return { sort() { return this; }, async lean() { return rows.map(row => ({ ...row })); } };
    }
    static async countDocuments(filter) { return (await this.find(filter).lean()).length; }
  };
}
function pdfRooms() {
  const rows = [{ room: '101', type: 'NQ1', housekeepingStatus: 'Dirty', occupancyStatus: 'Vacant' }];
  rows.sourceReportDate = day;
  return rows;
}
const uploadRequest = bytes => ({ body: { reportDate: day }, file: { buffer: bytes, originalname: 'morning.pdf' } });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function delayedImportCleanup() {
  const LockModel = memoryLockModel();
  const releaseStarted = deferred(), allowRelease = deferred();
  const cleanupStarted = deferred(), allowCleanup = deferred();
  const deleteOne = LockModel.deleteOne;
  LockModel.deleteOne = async filter => {
    releaseStarted.resolve();
    await allowRelease.promise;
    return deleteOne.call(LockModel, filter);
  };
  let committed = false, cleaned = false;
  const sourceStorage = { async stageOriginal() {
    return {
      async commit() { committed = true; },
      async cleanup() { cleanupStarted.resolve(); await allowCleanup.promise; cleaned = true; }
    };
  } };
  return {
    LockModel, sourceStorage, releaseStarted, allowRelease, cleanupStarted, allowCleanup,
    get committed() { return committed; }, get cleaned() { return cleaned; }
  };
}

test('a successful hosted upload sends its response only after asynchronous lease release and staged cleanup', async () => {
  const cleanup = delayedImportCleanup();
  const events = [];
  const handler = createUploadReport({
    vercel: true, ReportModel: memoryReportModel(), sourceStorage: cleanup.sourceStorage,
    importLocks: createMongoImportLocks({ LockModel: cleanup.LockModel, heartbeat: false }),
    extractPDF: async () => pdfRooms(), syncMetadata: async () => ({ upsertedCount: 1, modifiedCount: 0 })
  });
  const req = { ...uploadRequest(Buffer.from('%PDF-lifecycle-fixture')), app: { get: () => ({ emit: (...event) => events.push(event) }) } };
  const res = response();
  const finished = handler(req, res);
  await cleanup.releaseStarted.promise;
  assert.equal(cleanup.committed, true);
  assert.equal(cleanup.LockModel.rows.size, 1);
  assert.equal(res.body, undefined, 'Vercel must not finish the response while the shared lease is still held');
  cleanup.allowRelease.resolve();
  await cleanup.cleanupStarted.promise;
  assert.equal(cleanup.LockModel.rows.size, 0);
  assert.equal(res.body, undefined, 'Response must also wait for the staged original cleanup');
  cleanup.allowCleanup.resolve();
  assert.equal(await finished, res);
  assert.equal(cleanup.cleaned, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.data[0].room, '101');
  assert.equal(res.body.housekeepingCreatedCount, 1);
  assert.deepEqual(res.body.warnings, []);
  assert.equal(res.body.pdfUrl, `/api/room-sheets/${day}/download`);
  assert.deepEqual(events.map(([event]) => event), ['housekeepingBulkUpdated', 'roomDataUpdated']);
});

test('a failed hosted upload waits for asynchronous lease release and cleanup before sending the original error', async () => {
  const cleanup = delayedImportCleanup();
  const ReportModel = memoryReportModel();
  ReportModel.bulkWrite = async () => { const error = new Error('The report changed. Retry the import'); error.status = 409; throw error; };
  const handler = createUploadReport({
    vercel: true, ReportModel, sourceStorage: cleanup.sourceStorage,
    importLocks: createMongoImportLocks({ LockModel: cleanup.LockModel, heartbeat: false }),
    extractPDF: async () => pdfRooms(), syncMetadata: async () => assert.fail('Failed import must not synchronize rooms')
  });
  const res = response();
  const finished = handler(uploadRequest(Buffer.from('%PDF-lifecycle-fixture')), res);
  await cleanup.releaseStarted.promise;
  assert.equal(res.body, undefined, 'Error paths must retain the invocation until lease deletion finishes');
  assert.equal(cleanup.LockModel.rows.size, 1);
  assert.equal(cleanup.committed, false);
  cleanup.allowRelease.resolve();
  await cleanup.cleanupStarted.promise;
  assert.equal(cleanup.LockModel.rows.size, 0);
  assert.equal(res.body, undefined);
  cleanup.allowCleanup.resolve();
  assert.equal(await finished, res);
  assert.equal(cleanup.cleaned, true);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { success: false, message: 'The report changed. Retry the import' });
});

test('Vercel original PDF survives a fresh handler/storage instance and replaces only its date', async () => {
  const OriginalModel = memoryOriginalModel();
  const LockModel = memoryLockModel();
  const ReportModel = memoryReportModel();
  const bytes = Buffer.from('%PDF-exact-original-fixture-bytes');
  const handler = createUploadReport({ vercel: true, ReportModel, sourceStorage: createMongoReportStorage({ OriginalModel }), importLocks: createMongoImportLocks({ LockModel, heartbeat: false }), extractPDF: async () => pdfRooms(), syncMetadata: async () => ({}) });
  const imported = response();
  await handler(uploadRequest(bytes), imported);
  assert.equal(imported.statusCode, 200);
  assert.equal(imported.body.pdfUrl, `/api/room-sheets/${day}/download`);
  assert.equal(LockModel.rows.size, 0);
  assert.deepEqual(OriginalModel.rows.get(day).data, bytes);

  // Recreate both dependencies to simulate another Vercel invocation.
  const handlers = createRoomSheetHandlers({ vercel: true, ReportModel, sourceStorage: createMongoReportStorage({ OriginalModel }) });
  const listed = response();
  await handlers.getRoomSheets({ query: { date: day } }, listed);
  assert.equal(listed.body.length, 2);
  assert.equal(listed.body[0].source, 'mongodb');
  assert.equal(listed.body[0].bytes, bytes.length);
  assert.deepEqual(OriginalModel.selections, ['-data']);
  const download = response();
  await handlers.getRoomSheetDownload({ params: { date: day } }, download);
  assert.deepEqual(download.body, bytes);
  assert.equal(download.headers['Content-Type'], 'application/pdf');
  assert.equal(download.headers['Content-Length'], String(bytes.length));
  assert.equal(download.headers['Cache-Control'], 'private, no-store');
  assert.match(download.headers['Content-Disposition'], /room_sheet_2026-10-03_original.pdf/);

  const nextDate = '2026-10-04';
  const storage = createMongoReportStorage({ OriginalModel });
  await (await storage.stageOriginal(nextDate, Buffer.from('another-day'))).commit();
  await (await storage.stageOriginal(day, Buffer.from('replacement'))).commit();
  assert.equal(OriginalModel.rows.size, 2);
  assert.equal(OriginalModel.rows.get(nextDate).data.toString(), 'another-day');
  assert.equal(OriginalModel.rows.get(day).data.toString(), 'replacement');
});

test('Mongo storage handles BSON Binary reads and rejects oversized or incomplete originals', async () => {
  const OriginalModel = memoryOriginalModel();
  const storage = createMongoReportStorage({ OriginalModel });
  const binary = Buffer.from('%PDF-binary-fixture');
  OriginalModel.rows.set(day, { data: { value: raw => { assert.equal(raw, true); return binary; } }, bytes: binary.length, updatedAt: new Date() });
  assert.deepEqual((await storage.getOriginal(day, { includeBuffer: true })).buffer, binary);
  OriginalModel.rows.get(day).bytes += 1;
  await assert.rejects(storage.getOriginal(day, { includeBuffer: true }), /incomplete/);
  OriginalModel.rows.get(day).bytes = VERCEL_REPORT_BYTES + 1;
  await assert.rejects(storage.getOriginal(day), { status: 413 });
  await assert.rejects(storage.stageOriginal(day, Buffer.alloc(VERCEL_REPORT_BYTES + 1)), { status: 413 });
  await (await storage.stageOriginal(day, Buffer.alloc(VERCEL_REPORT_BYTES))).commit();
  assert.equal((await storage.getOriginal(day, { includeBuffer: true })).buffer.length, VERCEL_REPORT_BYTES);
});

test('two independent import managers collide on an active date and take over an expired lease before TTL deletion', async () => {
  const LockModel = memoryLockModel();
  let time = new Date('2026-10-03T12:00:00Z');
  const firstManager = createMongoImportLocks({ LockModel, now: () => time, heartbeat: false, token: () => 'first-owner' });
  const secondManager = createMongoImportLocks({ LockModel, now: () => time, heartbeat: false, token: () => 'second-owner' });
  const first = await firstManager.acquire(day);
  assert.equal(LockModel.rows.get(day).expiresAt.getTime() - time.getTime(), IMPORT_LEASE_MS);
  await assert.rejects(secondManager.acquire(day), { status: 409 });
  const otherDate = await secondManager.acquire('2026-10-04');
  await otherDate.release();
  time = new Date(time.getTime() + IMPORT_LEASE_MS);
  assert.equal(LockModel.rows.size, 1); // The old TTL row still exists.
  const replacement = await secondManager.acquire(day);
  await assert.rejects(first.assertOwned(), { status: 409 });
  await first.release();
  assert.equal(LockModel.rows.get(day).ownerToken, 'second-owner');
  await replacement.assertOwned();
  await replacement.release();
  assert.equal(LockModel.rows.size, 0);
});

test('lease renewal extends an active import and an expired owner cannot renew itself', async () => {
  const LockModel = memoryLockModel();
  let time = new Date('2026-10-03T12:00:00Z');
  const manager = createMongoImportLocks({ LockModel, now: () => time, heartbeat: false });
  const lease = await manager.acquire(day);
  time = new Date(time.getTime() + 60000);
  await lease.assertOwned();
  assert.equal(LockModel.rows.get(day).expiresAt.getTime(), time.getTime() + IMPORT_LEASE_MS);
  time = new Date(time.getTime() + IMPORT_LEASE_MS);
  await assert.rejects(lease.assertOwned(), /lease expired/);
  await lease.release();
});

test('concurrent Vercel upload rejects the second invocation and releases the first after validation failure', async () => {
  const LockModel = memoryLockModel();
  const OriginalModel = memoryOriginalModel();
  const ReportModel = memoryReportModel();
  let finishPDF, started;
  const parsing = new Promise(resolve => { started = resolve; });
  const blockedPDF = new Promise(resolve => { finishPDF = resolve; });
  const options = { vercel: true, ReportModel, sourceStorage: createMongoReportStorage({ OriginalModel }), syncMetadata: async () => ({}) };
  const first = createUploadReport({ ...options, importLocks: createMongoImportLocks({ LockModel, heartbeat: false }), extractPDF: async () => { started(); return blockedPDF; } });
  const second = createUploadReport({ ...options, importLocks: createMongoImportLocks({ LockModel, heartbeat: false }), extractPDF: async () => pdfRooms() });
  const firstResponse = response();
  const pending = first(uploadRequest(Buffer.from('%PDF-fixture')), firstResponse);
  await parsing;
  const collision = response();
  await second(uploadRequest(Buffer.from('%PDF-fixture')), collision);
  assert.equal(collision.statusCode, 409);
  assert.match(collision.body.message, /already processing/);
  assert.equal(ReportModel.writes, 0);
  finishPDF([{ ...pdfRooms()[0], sourceReportDate: day, housekeepingStatus: 'invalid' }]);
  await pending;
  assert.equal(firstResponse.statusCode, 400);
  assert.equal(LockModel.rows.size, 0);
  assert.equal(OriginalModel.rows.size, 0);
});

test('an import that loses its lease writes neither room rows nor original PDF and cannot release a new owner', async () => {
  const LockModel = memoryLockModel();
  const OriginalModel = memoryOriginalModel();
  const ReportModel = memoryReportModel();
  let time = new Date('2026-10-03T12:00:00Z'), replacement;
  const locks = token => createMongoImportLocks({ LockModel, now: () => time, heartbeat: false, token: () => token });
  const handler = createUploadReport({ vercel: true, ReportModel, sourceStorage: createMongoReportStorage({ OriginalModel }), importLocks: locks('old'), syncMetadata: async () => ({}), extractPDF: async () => {
    time = new Date(time.getTime() + IMPORT_LEASE_MS);
    replacement = await locks('new').acquire(day);
    return pdfRooms();
  } });
  const res = response();
  await handler(uploadRequest(Buffer.from('%PDF-fixture')), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /lease expired/);
  assert.equal(ReportModel.writes, 0);
  assert.equal(OriginalModel.rows.size, 0);
  assert.equal(LockModel.rows.get(day).ownerToken, 'new');
  await replacement.release();
});

test('Vercel buffer upload enforces 4 MB before parsing and releases its distributed lock', async () => {
  const LockModel = memoryLockModel();
  let parsed = false;
  const handler = createUploadReport({ vercel: true, ReportModel: memoryReportModel(), sourceStorage: createMongoReportStorage({ OriginalModel: memoryOriginalModel() }), importLocks: createMongoImportLocks({ LockModel, heartbeat: false }), extractPDF: async () => { parsed = true; return pdfRooms(); } });
  const res = response();
  await handler(uploadRequest(Buffer.alloc(VERCEL_REPORT_BYTES + 1)), res);
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.message, 'Report files must be 4 MB or smaller');
  assert.equal(parsed, false);
  assert.equal(LockModel.rows.size, 0);
});

async function runMemoryMultipart(contents) {
  const boundary = 'motel-report-memory-boundary';
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="report"; filename="morning.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), contents, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const req = Readable.from(payload);
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) };
  const res = response();
  await new Promise((resolve, reject) => {
    const originalJSON = res.json;
    res.json = value => { originalJSON.call(res, value); resolve(); return res; };
    createReportUpload({ vercel: true }).single('report')(req, res, error => error ? reject(error) : resolve());
  });
  return { req, res };
}

test('Vercel multipart middleware keeps bytes in memory and returns a JSON 413 above 4 MB', async () => {
  const bytes = Buffer.from('%PDF-memory-only-fixture');
  const good = await runMemoryMultipart(bytes);
  assert.deepEqual(good.req.file.buffer, bytes);
  assert.equal(good.req.file.path, undefined);
  assert.equal(good.req.file.filename, undefined);
  const oversized = await runMemoryMultipart(Buffer.alloc(VERCEL_REPORT_BYTES + 1));
  assert.equal(oversized.res.statusCode, 413);
  assert.equal(oversized.res.body.message, 'Report files must be 4 MB or smaller');
});

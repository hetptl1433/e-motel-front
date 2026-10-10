const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const { existsSync } = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const Report = require('../src/models/RoomReport');
const { parseCSV, parseJSON, prepareRooms, dateText } = require('../src/utils/reportImport');
const { parseRoomPDF, parseTablePage } = require('../src/utils/pdfRoomParser');
const { buildRoomSheetPDF, sourceReportPath } = require('../src/utils/roomSheetPDF');
const { createUploadReport } = require('../src/controllers/reportController');
const { createRoomSheetHandlers } = require('../src/controllers/roomSheetController');
const upload = require('../src/middleware/upload');

const samplePath = path.join(__dirname, '../reports/AAsamplw.pdf');
const earlierSamplePath = path.join(__dirname, '../room_sheet.pdf');
const privateFixture = filename => ({ skip: existsSync(filename) ? false : `Private local PDF fixture ${path.basename(filename)} is absent; original motel reports are excluded from the public repository` });
const day = '2026-10-03';
const basicRoom = (room = '101') => ({ room, type: 'NQ1', housekeepingStatus: 'Dirty', occupancyStatus: 'Vacant' });

function pageFixture({ footer = '10/03/2026 08:15:55 PM Page 1 of 1', room = '101' } = {}) {
  const item = (str, x, y) => ({ str, transform: [1, 0, 0, 1, x, y] });
  return [
    item('ROOM', 45, 533), item('ROOM', 115, 533), item('TYPE', 115, 521),
    item('HOUSEKEEPING', 165, 533), item('OCCUPANCY', 255, 533), item('GUEST', 330, 533),
    item('CHECK-IN', 400, 533), item('CHECK-OUT', 460, 533), item('ORDER', 530, 533),
    item('DESCRIPTION', 590, 521), item('ASSIGNED', 670, 533), item('NOTES', 745, 533),
    item(room, 45, 488), item('NQ1', 115, 488), item('Dirty', 165, 488), item('Vacant', 255, 488),
    item('Stay Over', 330, 488), item('Oct 02', 400, 488), item('Oct 04', 460, 488),
    item('Leaking', 590, 488), item('faucet', 590, 477), item('Sam', 670, 488),
    item(footer, 641, 25), item('Room Status', 32, 12), item('85841-Super 8 by Wyndham Shipshewana', 300, 12)
  ];
}

function fixturePDF(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const pageIds = pages.map(items => {
    const stream = items.map(item => `BT /F1 9 Tf 1 0 0 1 ${item.transform[4]} ${item.transform[5]} Tm (${item.str.replace(/([\\()])/g, '\\$1')}) Tj ET`).join('\n');
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    const streamId = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`);
    return objects.length;
  });
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  if (pdf.length < 4096) pdf += `%${' '.repeat(4096 - pdf.length)}\n`;
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function memoryReportModel() {
  class MemoryReport {
    constructor(value) { this.value = value; }
    validate() { return new Report(this.value).validate(); }
    static rows = [];
    static writes = 0;
    static async bulkWrite(operations) {
      this.writes += 1;
      for (const { updateOne } of operations) {
        const existing = this.rows.find(row => (!updateOne.filter._id || row._id === updateOne.filter._id) && row.room === updateOne.filter.room && row.reportDate >= updateOne.filter.reportDate.$gte && row.reportDate < updateOne.filter.reportDate.$lt && (!Object.hasOwn(updateOne.filter, 'checkedOutAt') || row.checkedOutAt == null));
        if (existing) Object.assign(existing, updateOne.update.$set);
        else if (updateOne.upsert) this.rows.push({ _id: String(this.rows.length + 1), ...updateOne.update.$setOnInsert, ...updateOne.update.$set });
      }
      return { acknowledged: true };
    }
    static find(filter) {
      const rows = this.rows.filter(row => row.reportDate >= filter.reportDate.$gte && row.reportDate < filter.reportDate.$lt && (!filter.room || filter.room.$in.includes(row.room)));
      const query = { sort() { rows.sort((a, b) => String(b._id).localeCompare(String(a._id))); return this; }, lean() { return Promise.resolve(rows.map(row => ({ ...row }))); } };
      return query;
    }
    static async countDocuments(filter) { return (await this.find(filter).lean()).length; }
  }
  return MemoryReport;
}

function response() {
  return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, set(key, value) { if (typeof key === 'string') this.headers[key] = value; else Object.assign(this.headers, key); return this; }, send(value) { this.body = value; return this; }, download(filename, name, callback) { this.filename = filename; this.downloadName = name; callback(); return this; } };
}

test('authoritative three-page Super 8 sample has all 54 exact rooms, dates, statuses, orders, and pet', privateFixture(samplePath), async () => {
  const raw = await parseRoomPDF(await fs.readFile(samplePath));
  assert.equal(raw.sourceReportDate, day);
  assert.equal(raw.pageCount, 3);
  const rooms = prepareRooms(raw, day, { requireType: true, strictDates: true });
  const expected = [...Array.from({ length: 24 }, (_, i) => String(101 + i)), ...Array.from({ length: 30 }, (_, i) => String(201 + i))];
  assert.deepEqual(rooms.map(room => room.room), expected);
  assert.equal(new Set(rooms.map(room => room.room)).size, 54);
  assert.equal(rooms.filter(room => room.housekeepingStatus === 'Clean').length, 30);
  assert.equal(rooms.filter(room => room.housekeepingStatus === 'Dirty').length, 24);
  assert.equal(rooms.filter(room => room.occupancyStatus === 'Occupied').length, 39);
  assert.deepEqual(rooms.filter(room => room.pet).map(room => room.room), ['121']);
  assert.deepEqual(rooms.filter(room => room.orderStatus === 'OOI/OI').map(room => room.room), ['101', '230']);
  assert.equal(rooms[0].guestStatus, null);
  assert.equal(rooms[0].description, 'OTHER ISSUES');
  assert.equal(rooms.find(room => room.room === '102').checkIn, '2026-10-03');
  assert.equal(rooms.find(room => room.room === '102').checkOut, '2026-10-04');
});

test('earlier Super 8 sample preserves its printed source year', privateFixture(earlierSamplePath), async () => {
  const raw = await parseRoomPDF(await fs.readFile(earlierSamplePath));
  assert.equal(raw.sourceReportDate, '2025-05-22');
  const rooms = prepareRooms(raw, '2025-05-22', { requireType: true, strictDates: true });
  assert.equal(rooms.length, 54);
  assert.equal(rooms.find(room => room.room === '102').checkIn, '2025-05-22');
  assert.equal(rooms.find(room => room.room === '228').pet, true);
});

test('fixed table parser preserves split cell text and rejects missing headers, identity, footer and invalid rooms', () => {
  const rows = parseTablePage(pageFixture());
  assert.equal(rows[0].description, 'Leaking faucet');
  assert.deepEqual(rows.metadata, { sourceReportDate: day, pageNumber: 1, pageCount: 1 });
  assert.throws(() => parseTablePage(pageFixture().filter(item => item.str !== 'HOUSEKEEPING')), /missing.*housekeepingStatus/i);
  assert.throws(() => parseTablePage(pageFixture().filter(item => !item.str.includes('Super 8'))), /Unsupported PDF/);
  assert.throws(() => parseTablePage(pageFixture({ footer: '' })), /missing.*date and page count/i);
  assert.throws(() => parseTablePage(pageFixture({ room: '1000' })), /three digits/);
  assert.throws(() => parseTablePage(pageFixture().filter(item => item.str !== 'Vacant')), /missing required table data/);
  assert.throws(() => parseTablePage(pageFixture({ footer: '02/30/2026 08:15:55 PM Page 1 of 1' })), /calendar date/);
});

test('local parser rejects a renamed non-PDF and a generated current sheet of unsupported layout', async () => {
  await assert.rejects(parseRoomPDF(Buffer.from('not a PDF')), /not a valid PDF/);
  await assert.rejects(parseRoomPDF(buildRoomSheetPDF([basicRoom()], day)), /missing.*report date and page count|Unsupported PDF|recognizable|missing.*column/i);
});

test('full PDF parser rejects a missing or failed page, inconsistent dates, and reversed page order', async () => {
  const first = pageFixture({ footer: '10/03/2026 08:15:55 PM Page 1 of 2' });
  const second = pageFixture({ room: '102', footer: '10/03/2026 08:15:55 PM Page 2 of 2' });
  assert.equal((await parseRoomPDF(fixturePDF([first, second]))).length, 2);
  await assert.rejects(parseRoomPDF(fixturePDF([first])), /page numbers.*inconsistent/i);
  await assert.rejects(parseRoomPDF(fixturePDF([second, first])), /page numbers.*inconsistent/i);
  const wrongDay = pageFixture({ room: '102', footer: '10/04/2026 08:15:55 PM Page 2 of 2' });
  await assert.rejects(parseRoomPDF(fixturePDF([first, wrongDay])), /different report dates/);
  await assert.rejects(parseRoomPDF(fixturePDF([first, second.filter(item => item.str !== 'HOUSEKEEPING')])), /missing.*housekeepingStatus/i);
});

test('CSV and JSON imports validate all records, quoted values and duplicate identity', () => {
  const rows = parseCSV('room,type,housekeepingStatus,occupancyStatus,notes\r\n101,NQ1,dirty,vacant,"Call Sam, then inspect\nLock says ""locked"""\r\n');
  assert.equal(rows[0].notes, 'Call Sam, then inspect\nLock says "locked"');
  assert.equal(prepareRooms(rows, day)[0].housekeepingStatus, 'Dirty');
  assert.deepEqual(parseJSON(JSON.stringify({ rooms: [basicRoom()] })), [basicRoom()]);
  assert.throws(() => parseCSV('room,room\n101,102'), /unique/);
  assert.throws(() => parseCSV('room,type\n101'), /number of columns/);
  assert.throws(() => parseCSV('room\n"101'), /unterminated/);
  assert.throws(() => parseJSON('{}'), /room array/);
  assert.throws(() => prepareRooms([basicRoom(), basicRoom()], day), /Duplicate room/);
  assert.throws(() => prepareRooms([{ ...basicRoom(), housekeepingStatus: 'unknown' }], day), /Housekeeping status/);
  assert.throws(() => prepareRooms([], day), /no rooms/);
  assert.throws(() => prepareRooms([basicRoom()], '2026-02-30'), /calendar date/);
  assert.throws(() => prepareRooms([{ ...basicRoom(), pet: 'sometimes' }], day), /pet must/);
});

test('stay date normalization handles year boundaries and strict invalid dates', () => {
  assert.equal(dateText('Dec 31', '2026-01-02'), '2025-12-31');
  assert.equal(dateText('Jan 02', '2025-12-31'), '2026-01-02');
  assert.equal(dateText('10/04/2026', day), '2026-10-04');
  assert.throws(() => dateText('Feb 30', day, { strict: true }), /invalid/);
  assert.throws(() => dateText('yesterday', day, { strict: true }), /Unsupported/);
});

test('upload is date-scoped, repeatable, preserves cleaning work, refreshes metadata and removes temporary files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'motel-report-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const Model = memoryReportModel();
  const synced = [];
  const handler = createUploadReport({ ReportModel: Model, storageDirectory: directory, syncMetadata: async rooms => { synced.push(rooms); return { modifiedCount: 1 }; } });
  const run = async (rooms, date) => {
    const filename = path.join(directory, `upload-${Math.random()}.json`);
    await fs.writeFile(filename, JSON.stringify(rooms));
    const req = { body: { reportDate: date }, file: { path: filename, originalname: '../../rooms.json' }, app: { get: () => ({ emit() {} }) } };
    const res = response(); await handler(req, res);
    await assert.rejects(fs.access(filename), { code: 'ENOENT' });
    return res;
  };
  assert.equal((await run([basicRoom()], day)).body.count, 1);
  Model.rows[0].housekeepingStatus = 'Clean'; Model.rows[0].notes = 'Inspected'; Model.rows[0].assignedAttendant = 'Sam';
  const again = await run([{ ...basicRoom(), occupancyStatus: 'Occupied', notes: 'source note' }], day);
  assert.equal(Model.rows.length, 1);
  assert.equal(again.body.data[0].housekeepingStatus, 'Clean');
  assert.equal(again.body.data[0].notes, 'Inspected');
  assert.equal(again.body.data[0].assignedAttendant, 'Sam');
  assert.equal(again.body.data[0].occupancyStatus, 'Occupied');
  await run([basicRoom()], '2026-10-04');
  assert.equal(Model.rows.length, 2);
  assert.equal(Model.rows[1].housekeepingStatus, 'Dirty');
  const writes = Model.writes;
  assert.equal((await run([basicRoom(), { ...basicRoom('102'), housekeepingStatus: 'invalid' }], day)).statusCode, 400);
  assert.equal((await run([basicRoom(), basicRoom()], day)).statusCode, 400);
  assert.equal((await run([basicRoom()], '2026-02-30')).statusCode, 400);
  assert.equal(Model.writes, writes);
  assert.equal(synced.length, 3);
});

test('PDF upload archives exact source bytes and rejects date mismatch before saving', privateFixture(samplePath), async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'motel-pdf-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const Model = memoryReportModel();
  const bytes = await fs.readFile(samplePath);
  const handler = createUploadReport({ ReportModel: Model, storageDirectory: directory, syncMetadata: async () => ({ modifiedCount: 0 }) });
  const run = async date => {
    const filename = path.join(directory, 'temporary.pdf'); await fs.writeFile(filename, bytes);
    const res = response(); await handler({ body: { reportDate: date }, file: { path: filename, originalname: 'AAsamplw.pdf' } }, res);
    await assert.rejects(fs.access(filename), { code: 'ENOENT' });
    return res;
  };
  const wrong = await run('2026-10-02');
  assert.equal(wrong.statusCode, 400); assert.match(wrong.body.message, /PDF is dated 2026-10-03/); assert.equal(Model.writes, 0);
  const good = await run(day); assert.equal(good.body.count, 54); assert.equal(Model.rows.length, 54);
  assert.deepEqual(await fs.readFile(sourceReportPath(day, directory)), bytes);
  await run(day); assert.equal(Model.rows.length, 54);
});

test('re-upload updates the latest legacy duplicate and preserves its staff work without deleting history', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'motel-duplicate-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const Model = memoryReportModel();
  Model.rows.push(
    { ...basicRoom(), _id: '1', reportDate: new Date(`${day}T00:00:00Z`), notes: 'Older snapshot' },
    { ...basicRoom(), _id: '2', reportDate: new Date(`${day}T00:00:00Z`), housekeepingStatus: 'Clean', notes: 'Inspected by Sam', assignedAttendant: 'Sam' }
  );
  const handler = createUploadReport({ ReportModel: Model, storageDirectory: directory, syncMetadata: async () => ({ modifiedCount: 0 }) });
  const filename = path.join(directory, 'temporary.json');
  await fs.writeFile(filename, JSON.stringify([{ ...basicRoom(), occupancyStatus: 'Occupied' }]));
  const res = response();
  await handler({ body: { reportDate: day }, file: { path: filename, originalname: 'rooms.json' } }, res);
  assert.equal(res.body.count, 1); assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].housekeepingStatus, 'Clean'); assert.equal(res.body.data[0].notes, 'Inspected by Sam');
  assert.equal(res.body.data[0].occupancyStatus, 'Occupied'); assert.equal(Model.rows.length, 2);
  assert.equal(Model.rows[0].notes, 'Older snapshot');
});

test('re-upload preserves a completed checkout and requests automatic housekeeping import with counts', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'motel-checkout-import-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const Model = memoryReportModel();
  const checkedOutAt = new Date(`${day}T12:00:00Z`);
  Model.rows.push({ ...basicRoom(), _id: '1', reportDate: new Date(`${day}T00:00:00Z`), occupancyStatus: 'Vacant', housekeepingStatus: 'Clean', guestStatus: 'Checked-out', checkedOutAt, notes: 'Finished by Sam', assignedAttendant: 'Sam' });
  const events = [];
  const handler = createUploadReport({ ReportModel: Model, storageDirectory: directory, syncMetadata: async (records, date, options) => {
    assert.equal(date, day);
    assert.deepEqual(options, { ensureRecords: true });
    assert.equal(records.find(record => record.room === '101').occupancyStatus, 'Vacant');
    assert.equal(records.find(record => record.room === '101').guestStatus, 'Checked-out');
    return { upsertedCount: 1, modifiedCount: 1 };
  } });
  const filename = path.join(directory, 'morning.json');
  await fs.writeFile(filename, JSON.stringify([
    { ...basicRoom(), occupancyStatus: 'Occupied', guestStatus: 'Due Out', notes: 'Morning source note' },
    basicRoom('102')
  ]));
  const res = response();
  await handler({ body: { reportDate: day }, file: { path: filename, originalname: 'morning.json' }, app: { get: () => ({ emit: (...event) => events.push(event) }) } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.housekeepingCreatedCount, 1);
  assert.equal(res.body.housekeepingUpdatedCount, 1);
  const preserved = res.body.data.find(record => record.room === '101');
  assert.equal(preserved.occupancyStatus, 'Vacant');
  assert.equal(preserved.housekeepingStatus, 'Clean');
  assert.equal(preserved.guestStatus, 'Checked-out');
  assert.equal(preserved.checkedOutAt, checkedOutAt);
  assert.equal(preserved.notes, 'Finished by Sam');
  assert.equal(preserved.assignedAttendant, 'Sam');
  assert.deepEqual(events.map(([event, payload]) => [event, payload.date]), [['housekeepingBulkUpdated', day], ['roomDataUpdated', day]]);
});

test('room-sheet list/download/current PDF works locally and validates unsafe dates', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'motel-sheet-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const Model = memoryReportModel();
  Model.rows.push({ ...basicRoom(), reportDate: new Date(`${day}T00:00:00Z`) });
  await fs.writeFile(sourceReportPath(day, directory), 'original test source');
  const handlers = createRoomSheetHandlers({ ReportModel: Model, storageDirectory: directory });
  const listed = response(); await handlers.getRoomSheets({ query: { date: day } }, listed);
  assert.equal(listed.body.length, 2); assert.ok(listed.body.every(file => file.source === 'local'));
  const downloaded = response(); await handlers.getRoomSheetDownload({ params: { date: day } }, downloaded);
  assert.equal(downloaded.filename, sourceReportPath(day, directory));
  const current = response(); await handlers.getGeneratedRoomSheet({ params: { date: day } }, current);
  assert.equal(current.headers['Content-Type'], 'application/pdf'); assert.equal(current.body.subarray(0, 5).toString(), '%PDF-');
  const parsed = await require('pdf-parse')(current.body); assert.match(parsed.text, /101/); assert.match(parsed.text, /Dirty/);
  const empty = response(); await handlers.getRoomSheets({ query: { date: '2026-10-04' } }, empty); assert.deepEqual(empty.body, []);
  const unsafe = response(); await handlers.getRoomSheetDownload({ params: { date: '../../.env' } }, unsafe); assert.equal(unsafe.statusCode, 400);
  const missing = response(); await handlers.getGeneratedRoomSheet({ params: { date: '2026-10-04' } }, missing); assert.equal(missing.statusCode, 404);
});

test('generated PDF paginates long notes and reports unavailable order separately', async () => {
  const rows = Array.from({ length: 54 }, (_, index) => ({ ...basicRoom(String(101 + index)), housekeepingStatus: 'Clean', notes: index === 0 ? 'Check the leaking faucet and replace the damaged floor. '.repeat(170) : null }));
  rows[0].orderStatus = 'OOI/OI';
  const pdf = buildRoomSheetPDF(rows, day);
  const parsed = await require('pdf-parse')(pdf);
  assert.ok(parsed.numpages >= 4);
  assert.match(parsed.text, /53 clean/); assert.match(parsed.text, /1 unavailable/); assert.match(parsed.text, /Availability: Unavailable/);
  assert.match(parsed.text, /154/); assert.match(parsed.text, /replace the damaged floor/);
});

test('multipart upload rejects wrong formats with JSON and uses unique safe names', async t => {
  const app = express();
  const filenames = [];
  app.post('/upload', upload.single('report'), async (req, res) => {
    filenames.push(req.file.filename);
    await fs.unlink(req.file.path);
    res.json({ filename: req.file.filename });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/upload`;
  const send = async name => {
    const form = new FormData(); form.append('report', new Blob(['room,housekeepingStatus,occupancyStatus\n101,Dirty,Vacant']), name);
    return fetch(url, { method: 'POST', body: form });
  };
  assert.equal((await send('../../report.csv')).status, 200);
  assert.equal((await send('../../report.csv')).status, 200);
  assert.notEqual(filenames[0], filenames[1]); assert.ok(filenames.every(name => /^[a-f\d-]+\.csv$/.test(name)));
  const rejected = await send('report.exe'); assert.equal(rejected.status, 400); assert.match((await rejected.json()).message, /PDF, CSV, and JSON/);
  const oversizedForm = new FormData(); oversizedForm.append('report', new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)]), 'large.pdf');
  const oversized = await fetch(url, { method: 'POST', body: oversizedForm });
  assert.equal(oversized.status, 413); assert.match((await oversized.json()).message, /10 MB or smaller/);
});

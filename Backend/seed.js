// Optional, non-destructive development setup. Existing users/rooms are preserved.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mongoose = require('mongoose');
const fs = require('fs/promises');
const path = require('path');
const User = require('./src/models/User');
const RoomReport = require('./src/models/RoomReport');
const { getMongoConfig, getMongoConfigError } = require('./src/config/mongo');
const { parseRoomPDF } = require('./src/utils/pdfRoomParser');
const { prepareRooms } = require('./src/utils/reportImport');

async function seed() {
  const password = process.env.MOTEL_SEED_PASSWORD;
  if (!password || password.length < 8 || Buffer.byteLength(password) > 72) throw new Error('Set MOTEL_SEED_PASSWORD (at least 8 characters, at most 72 UTF-8 bytes) before seeding.');
  const config = getMongoConfig();
  const error = getMongoConfigError(config);
  if (error) throw new Error(error);
  try {
    await mongoose.connect(config.uri, { serverSelectionTimeoutMS: 5000 });
    for (const [number, role] of [['101', 'housekeeping'], ['201', 'frontdesk'], ['301', 'admin']]) {
      if (!await User.exists({ number })) await User.create({ number, role, password });
    }
    // The sample is historical source data; seeding does not relabel it as today.
    const parsed = await parseRoomPDF(await fs.readFile(path.join(__dirname, 'reports', 'AAsamplw.pdf')));
    const rooms = prepareRooms(parsed, parsed.sourceReportDate, { requireType: true, strictDates: true });
    await RoomReport.bulkWrite(rooms.map(room => ({ updateOne: {
      filter: { room: room.room, reportDate: room.reportDate },
      update: { $setOnInsert: room }, upsert: true
    } })));
    console.log('Setup complete. Existing records preserved. User IDs: 101 (housekeeping), 201 (frontdesk), 301 (admin).');
  } finally { await mongoose.disconnect(); }
}

seed().catch(error => { console.error(error.message); process.exitCode = 1; });

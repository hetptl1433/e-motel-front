const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../src/models/User');
const { getMongoConfig, getMongoConfigError } = require('../src/config/mongo');

async function createUser() {
  const [number, role = 'frontdesk'] = process.argv.slice(2);
  const password = process.env.MOTEL_USER_PASSWORD;
  if (!number || !['housekeeping', 'frontdesk', 'admin'].includes(role)) {
    throw new Error('Usage: node scripts/createUser.js <ID> <housekeeping|frontdesk|admin>');
  }
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) {
    throw new Error('Set MOTEL_USER_PASSWORD to at least 8 characters and at most 72 UTF-8 bytes.');
  }
  const config = getMongoConfig();
  const error = getMongoConfigError(config);
  if (error) throw new Error(error);
  try {
    await mongoose.connect(config.uri, { serverSelectionTimeoutMS: 5000 });
    if (await User.exists({ number: number.trim() })) throw new Error('That user ID already exists.');
    await User.create({ number: number.trim(), role, password });
    console.log(`Created ${role} user ${number.trim()}.`);
  } finally { await mongoose.disconnect(); }
}

createUser().catch(error => {
  console.error(error.code === 11000 ? 'That user ID already exists.' : error.message);
  process.exitCode = 1;
});

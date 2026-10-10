const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const OriginalReport = require('../models/OriginalReport');
const { reportsDirectory, sourceReportPath } = require('./roomSheetPDF');
const { parseReportDate } = require('./roomData');
const { VERCEL_REPORT_BYTES, reportSizeError } = require('./reportLimits');

function createLocalReportStorage({ directory = reportsDirectory } = {}) {
  return {
    kind: 'local',
    async stageOriginal(date, buffer) {
      parseReportDate(date);
      await fs.mkdir(directory, { recursive: true });
      const filename = path.join(directory, `.room_sheet_${date}_${crypto.randomUUID()}.tmp`);
      await fs.writeFile(filename, buffer, { flag: 'wx', mode: 0o600 });
      let staged = true;
      return {
        async commit() { await fs.rename(filename, sourceReportPath(date, directory)); staged = false; },
        async cleanup() { if (staged) await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      };
    },
    async getOriginal(date) {
      const filename = sourceReportPath(date, directory);
      try {
        const stat = await fs.stat(filename);
        return stat.isFile() ? { filename, bytes: stat.size, createdAt: stat.mtime } : null;
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
  };
}

function storedBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  // Lean Mongoose reads return BSON Binary rather than a Mongoose Buffer.
  if (typeof value?.value === 'function') {
    const bytes = value.value(true);
    if (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) return Buffer.from(bytes);
  }
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error('The stored original report is unavailable');
}

function createMongoReportStorage({ OriginalModel = OriginalReport } = {}) {
  return {
    kind: 'mongodb',
    async stageOriginal(date, buffer) {
      parseReportDate(date);
      if (buffer.length > VERCEL_REPORT_BYTES) throw reportSizeError(true);
      return {
        async commit() {
          await OriginalModel.updateOne({ _id: date }, {
            $set: { reportDate: date, data: buffer, bytes: buffer.length, contentType: 'application/pdf' }
          }, { upsert: true, runValidators: true });
        },
        async cleanup() {}
      };
    },
    async getOriginal(date, { includeBuffer = false } = {}) {
      parseReportDate(date);
      let query = OriginalModel.findOne({ _id: date });
      if (!includeBuffer) query = query.select('-data');
      const record = await query.lean();
      if (!record) return null;
      if (record.bytes > VERCEL_REPORT_BYTES) throw reportSizeError(true);
      const original = { bytes: record.bytes, createdAt: record.updatedAt || record.createdAt };
      if (includeBuffer) {
        original.buffer = storedBuffer(record.data);
        if (original.buffer.length > VERCEL_REPORT_BYTES) throw reportSizeError(true);
        if (original.buffer.length !== record.bytes) throw new Error('The stored original report is incomplete');
      }
      return original;
    }
  };
}

module.exports = { createLocalReportStorage, createMongoReportStorage };

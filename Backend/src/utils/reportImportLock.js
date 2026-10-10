const crypto = require('crypto');
const ReportImportLock = require('../models/ReportImportLock');
const { parseReportDate } = require('./roomData');

const IMPORT_LEASE_MS = 5 * 60 * 1000;
function importConflict(message = 'A report for this date is already processing. Please wait and try again') {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function createLocalImportLocks(inProgress = new Set()) {
  return {
    async acquire(date) {
      if (inProgress.has(date)) throw importConflict();
      inProgress.add(date);
      return { async assertOwned() {}, async release() { inProgress.delete(date); } };
    }
  };
}

function createMongoImportLocks({ LockModel = ReportImportLock, now = () => new Date(), leaseMs = IMPORT_LEASE_MS, token = () => crypto.randomUUID(), heartbeat = true } = {}) {
  return {
    async acquire(date) {
      parseReportDate(date);
      const ownerToken = token();
      const acquiredAt = now();
      try {
        // A live lease fails the filter and the unique date ID rejects its
        // upsert. An expired lease is replaced atomically even before TTL runs.
        const owned = await LockModel.findOneAndUpdate({ _id: date, expiresAt: { $lte: acquiredAt } }, {
          $set: { reportDate: date, ownerToken, expiresAt: new Date(acquiredAt.getTime() + leaseMs) }
        }, { upsert: true, new: true, runValidators: true });
        if (!owned || owned.ownerToken !== ownerToken) throw importConflict();
      } catch (error) {
        if (error.code === 11000) throw importConflict();
        throw error;
      }
      let released = false, lost = false, timer;
      const assertOwned = async () => {
        if (released || lost) throw importConflict('The report import lease expired. Please retry the import');
        const current = now();
        const result = await LockModel.updateOne({ _id: date, ownerToken, expiresAt: { $gt: current } }, {
          $set: { expiresAt: new Date(current.getTime() + leaseMs) }
        });
        if (result.matchedCount !== 1) {
          lost = true;
          throw importConflict('The report import lease expired. Please retry the import');
        }
      };
      if (heartbeat) {
        timer = setInterval(() => { assertOwned().catch(() => { lost = true; }); }, Math.max(1000, Math.floor(leaseMs / 3)));
        timer.unref?.();
      }
      return {
        ownerToken,
        assertOwned,
        async release() {
          released = true;
          clearInterval(timer);
          await LockModel.deleteOne({ _id: date, ownerToken });
        }
      };
    }
  };
}

module.exports = { IMPORT_LEASE_MS, createLocalImportLocks, createMongoImportLocks };

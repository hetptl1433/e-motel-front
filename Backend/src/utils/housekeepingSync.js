const Housekeeper = require('../models/Housekeeper');
const { dateRange, normalizeFields } = require('./roomData');

const metadataFields = ['type', 'checkIn', 'checkOut', 'orderStatus', 'reason', 'description', 'pet'];

async function syncReportMetadata(rooms, date, { ensureRecords = false } = {}) {
  const records = rooms.map(room => {
    const source = room.toObject ? room.toObject() : room;
    const record = normalizeFields(source, { housekeeping: true, imported: true, reportDate: date });
    if (source.checkedOutAt) record.checkedOutAt = new Date(source.checkedOutAt);
    return { record, sourceUpdatedAt: source.updatedAt ? new Date(source.updatedAt) : null };
  });
  if (ensureRecords) await Promise.all(records.map(({ record }) => new Housekeeper(record).validate()));
  const operations = records.flatMap(({ record, sourceUpdatedAt }) => {
    const metadata = Object.fromEntries(metadataFields.filter(field => record[field] !== undefined).map(field => [field, record[field]]));
    const update = { $set: metadata };
    if (ensureRecords) update.$setOnInsert = Object.fromEntries(Object.entries(record).filter(([field]) => metadata[field] === undefined));
    const filter = { roomNumber: record.roomNumber, reportDate: dateRange(date) };
    const occupancy = Object.fromEntries(['occupancyStatus', 'guestStatus'].filter(field => record[field] !== undefined).map(field => [field, record[field]]));
    let checkoutGuard = { checkedOutAt: null };
    if (record.checkedOutAt) {
      occupancy.checkedOutAt = record.checkedOutAt;
      checkoutGuard = { $or: [
        { checkedOutAt: record.checkedOutAt },
        ...(sourceUpdatedAt && !Number.isNaN(sourceUpdatedAt.getTime()) ? [{ checkedOutAt: null, $or: [{ updatedAt: { $lte: sourceUpdatedAt } }, { updatedAt: null }] }] : [])
      ] };
    }
    return [{ updateMany: {
      // Evaluate freshness before the general metadata write changes updatedAt.
      // A current checkout snapshot can repair a failed secondary write, while
      // an older snapshot cannot undo a newer check-in or checkout marker.
      filter: { ...filter, ...checkoutGuard }, update: { $set: occupancy }, upsert: false
    } }, {
      [ensureRecords ? 'updateOne' : 'updateMany']: {
        filter,
        update,
        // One morning upload makes the day visible to housekeeping immediately.
        // Existing cleaning work stays untouched when the same report is uploaded again.
        upsert: ensureRecords
      }
    }];
  });
  if (!operations.length) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  const result = await Housekeeper.bulkWrite(operations, { ordered: true });
  // Each existing room may receive a guarded occupancy write and a metadata
  // write; the public import count describes rooms rather than operations.
  return ensureRecords ? { ...result, modifiedCount: Math.min(result.modifiedCount || 0, records.length - (result.upsertedCount || 0)) } : result;
}

module.exports = { syncReportMetadata };

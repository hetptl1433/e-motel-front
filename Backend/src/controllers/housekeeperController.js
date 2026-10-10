const mongoose = require('mongoose');
const Housekeeper = require('../models/Housekeeper');
const RoomReport = require('../models/RoomReport');
const { syncReportMetadata } = require('../utils/housekeepingSync');
const { dateRange, parseReportDate, normalizeRoomNumber, normalizeFields, isOutOfOrder, isRoomUnavailable, assertStaffCanClean, emitMutation, sendError, invalid, recordChanged, expectedVersion, assertExpectedVersion } = require('../utils/roomData');
const { assertCanServiceStayover, isStayover } = require('../utils/stayover');
const { synchronizeRecord } = require('../utils/recordSync');

const roomSyncFields = ['type', 'housekeepingStatus', 'occupancyStatus', 'guestStatus', 'checkIn', 'checkOut', 'checkedOutAt', 'stayoverServicedAt', 'orderStatus', 'reason', 'description', 'assignedAttendant', 'notes', 'pet'];
const recordDate = record => new Date(record.reportDate).toISOString().slice(0, 10);

async function updateHousekeepingRecord(id, updates, role, expectedUpdatedAt) {
  const serviceUpdate = Object.hasOwn(updates, 'stayoverServicedAt');
  if (serviceUpdate && (updates.occupancyStatus !== undefined || updates.housekeepingStatus !== undefined)) {
    throw invalid('Update stayover service separately from occupancy and cleaning status');
  }
  if (updates.occupancyStatus === 'Occupied') updates.checkedOutAt = null;
  const guarded = expectedUpdatedAt !== undefined || serviceUpdate || updates.occupancyStatus !== undefined || ['Clean', 'Dirty'].includes(updates.housekeepingStatus);
  if (!guarded) {
    return Housekeeper.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });
  }
  const current = await Housekeeper.findById(id);
  if (!current) return null;
  assertExpectedVersion(current, expectedUpdatedAt);
  assertStaffCanClean(current, updates, role);
  if (serviceUpdate) assertCanServiceStayover(current, updates);
  withCleaningTimestamp(updates, current);
  if (updates.occupancyStatus !== undefined && updates.occupancyStatus !== current.occupancyStatus) updates.stayoverServicedAt = null;
  const record = await Housekeeper.findOneAndUpdate({ _id: id, updatedAt: current.updatedAt ?? null }, { $set: updates }, { new: true, runValidators: true });
  if (!record) throw recordChanged();
  return record;
}

function withCleaningTimestamp(updates, current) {
  if (updates.housekeepingStatus === 'Clean' && updates.cleanedAt === undefined) updates.cleanedAt = current?.housekeepingStatus === 'Clean' && current.cleanedAt ? current.cleanedAt : new Date();
  if (updates.housekeepingStatus === 'Dirty') {
    updates.cleanedAt = null;
    updates.inspectedAt = null;
  }
  return updates;
}

async function syncToRoomReport(req, record, updates) {
  const changes = Object.fromEntries(Object.entries(updates).filter(([key]) => roomSyncFields.includes(key)));
  if (!Object.keys(changes).length || !record.reportDate) return;
  try {
    const date = recordDate(record);
    const filter = { room: record.roomNumber, reportDate: dateRange(date) };
    const result = await synchronizeRecord({
      SourceModel: Housekeeper, TargetModel: RoomReport, source: record, filter, changesFor: () => changes,
      canApply: target => {
        if (updates.stayoverServicedAt && !isStayover(target)) return false;
        if (req.user?.role === 'housekeeping' && ['Clean', 'Dirty'].includes(changes.housekeepingStatus)) return target.occupancyStatus === 'Vacant' && !isRoomUnavailable(target);
        return true;
      }
    });
    if (result.changed) {
      result.data.forEach(room => emitMutation(req, 'roomStatusUpdated', { action: 'housekeepingUpdate', date, data: room }));
    }
  } catch (error) {
    console.error('Room report synchronization failed:', error.message);
    return 'Housekeeping updated, but front desk synchronization failed. Refresh and try the change again.';
  }
}

exports.listHousekeeping = async (req, res) => {
  try {
    const date = req.query.date;
    const data = await Housekeeper.find(date ? { reportDate: dateRange(date) } : {}).sort({ reportDate: -1, roomNumber: 1 });
    res.json({ success: true, count: data.length, ...(date && { date }), data });
  } catch (error) {
    sendError(res, error, 'Failed to list housekeeping records');
  }
};

exports.updateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isObjectIdOrHexString(id)) throw invalid('Invalid housekeeper record ID format');
    const input = expectedVersion(req.body);
    const updates = normalizeFields(input.data, { housekeeping: true, partial: true, role: req.user?.role });
    const data = await updateHousekeepingRecord(id, updates, req.user?.role, input.expectedUpdatedAt);
    if (!data) return res.status(404).json({ success: false, message: 'Housekeeper record not found' });
    const warning = await syncToRoomReport(req, data, updates);
    emitMutation(req, 'housekeepingStatusUpdated', { action: 'update', recordId: id, roomNumber: data.roomNumber, date: data.reportDate ? recordDate(data) : undefined, updates, data });
    res.json({ success: true, data, ...(warning && { warning }) });
  } catch (error) {
    sendError(res, error, 'Failed to update housekeeper record');
  }
};

exports.createHousekeeping = async (req, res) => {
  try {
    const record = withCleaningTimestamp(normalizeFields(req.body, { housekeeping: true }));
    const date = recordDate(record);
    if (await Housekeeper.exists({ roomNumber: record.roomNumber, reportDate: dateRange(date) })) {
      return res.status(409).json({ success: false, message: 'A housekeeping record already exists for this room and date' });
    }
    const data = await Housekeeper.create(record);
    emitMutation(req, 'housekeepingRecordCreated', { action: 'create', date, data });
    res.status(201).json({ success: true, data });
  } catch (error) {
    sendError(res, error, 'Failed to create housekeeper record');
  }
};

exports.getHousekeepingByDate = async (req, res) => {
  try {
    const { date } = req.params;
    const data = await Housekeeper.find({ reportDate: dateRange(date) }).sort({ roomNumber: 1 });
    res.json({ success: true, count: data.length, date, data });
  } catch (error) {
    sendError(res, error, 'Failed to fetch housekeeping records');
  }
};

exports.getHousekeepingByRoom = async (req, res) => {
  try {
    const roomNumber = normalizeRoomNumber(req.params.roomNumber);
    const data = await Housekeeper.find({ roomNumber }).sort({ reportDate: -1, createdAt: -1 });
    res.json({ success: true, count: data.length, roomNumber, data });
  } catch (error) {
    sendError(res, error, 'Failed to fetch housekeeping records for room');
  }
};

async function importRecords(req, date, source, event) {
  const reportDate = parseReportDate(date);
  if (!Array.isArray(source) || !source.length) throw invalid('A non-empty rooms array is required');
  if (source.length > 1000) throw invalid('A maximum of 1000 rooms can be imported at a time');
  const seen = new Set();
  const records = source.map(room => {
    const value = room.toObject ? room.toObject() : room;
    const record = normalizeFields(value, { housekeeping: true, imported: true, reportDate: date });
    if (room.toObject && value.checkedOutAt) record.checkedOutAt = value.checkedOutAt;
    if (room.toObject && value.updatedAt) record.updatedAt = value.updatedAt;
    if (seen.has(record.roomNumber)) throw invalid(`Duplicate room number: ${record.roomNumber}`);
    seen.add(record.roomNumber);
    return { ...record, pet: record.pet ?? false, reportDate };
  });
  // Validate the complete batch before any writes; bad input must never destroy an existing day.
  await Promise.all(records.map(record => new Housekeeper(record).validate()));
  const filter = { reportDate: dateRange(date) };
  const existing = await Housekeeper.find(filter);
  const existingRooms = new Set(existing.map(record => record.roomNumber));
  const result = await syncReportMetadata(records, date, { ensureRecords: true });
  const data = await Housekeeper.find(filter).sort({ roomNumber: 1 });
  const payload = {
    action: 'import', date, imported: records.length, importedCount: records.length,
    createdCount: result.upsertedCount || 0,
    preservedCount: records.filter(record => existingRooms.has(record.roomNumber)).length,
    clearedCount: 0, count: data.length, data
  };
  if (result.upsertedCount || result.modifiedCount) emitMutation(req, event, payload);
  return payload;
}

exports.importToHousekeeping = async (req, res) => {
  try {
    const { date } = req.body || {};
    const reports = await RoomReport.find({ reportDate: dateRange(date) }).sort({ updatedAt: -1, createdAt: -1, _id: -1 });
    if (!reports.length) return res.status(404).json({ success: false, message: `No room reports found for ${date}` });
    // Older report uploads may have duplicates. Import the most recent version of each room.
    const unique = [...new Map(reports.map(record => [record.room, record]).reverse()).values()];
    const payload = await importRecords(req, date, unique, 'housekeepingDataImported');
    res.json({ success: true, message: `Imported ${payload.importedCount} rooms for ${date}`, ...payload });
  } catch (error) {
    sendError(res, error, 'Failed to import rooms to housekeeping');
  }
};

exports.importHousekeepingArray = async (req, res) => {
  try {
    const { date, rooms } = req.body || {};
    const payload = await importRecords(req, date, rooms, 'housekeepingArrayImported');
    res.json({ success: true, ...payload });
  } catch (error) {
    sendError(res, error, 'Failed to import housekeeping records');
  }
};

exports.bulkUpdateStatus = async (req, res) => {
  try {
    const { updates } = req.body || {};
    if (!Array.isArray(updates) || !updates.length || updates.length > 250) throw invalid('Provide an updates array with 1 to 250 records');
    const results = [];
    const errors = [];
    const warnings = [];
    for (const update of updates) {
      const id = update?.id;
      try {
        if (!mongoose.isObjectIdOrHexString(id)) throw invalid('Invalid ID format');
        const input = expectedVersion(update.data);
        const data = normalizeFields(input.data, { housekeeping: true, partial: true, role: req.user?.role });
        const record = await updateHousekeepingRecord(id, data, req.user?.role, input.expectedUpdatedAt);
        if (!record) throw invalid('Record not found');
        const warning = await syncToRoomReport(req, record, data);
        if (warning) warnings.push({ id, warning });
        results.push(record);
      } catch (error) {
        errors.push({ id, error: error.status || ['ValidationError', 'CastError'].includes(error.name) ? error.message : 'Failed to update record' });
      }
    }
    if (results.length) emitMutation(req, 'housekeepingBulkUpdated', { action: 'bulkUpdate', successCount: results.length, errorCount: errors.length, data: results, ...(warnings.length && { warnings }) });
    res.status(results.length ? 200 : 400).json({ success: results.length > 0, successCount: results.length, errorCount: errors.length, results, errors, ...(warnings.length && { warnings }) });
  } catch (error) {
    sendError(res, error, 'Failed to perform bulk update');
  }
};

exports.deleteHousekeeping = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isObjectIdOrHexString(id)) throw invalid('Invalid housekeeper record ID format');
    const data = await Housekeeper.findByIdAndDelete(id);
    if (!data) return res.status(404).json({ success: false, message: 'Housekeeper record not found' });
    emitMutation(req, 'housekeepingRecordDeleted', { action: 'delete', recordId: id, roomNumber: data.roomNumber, date: data.reportDate ? recordDate(data) : undefined, data });
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error, 'Failed to delete housekeeper record');
  }
};

exports.getHousekeepingSummary = async (req, res) => {
  try {
    const { date } = req.query;
    const data = await Housekeeper.find(date ? { reportDate: dateRange(date) } : {});
    const summary = { totalRooms: data.length, cleanRooms: 0, dirtyRooms: 0, occupiedRooms: 0, vacantRooms: 0, outOfOrderRooms: 0, maintenanceRooms: 0, unavailableRooms: 0, roomsWithPets: 0 };
    data.forEach(record => {
      const unavailable = isRoomUnavailable(record);
      if (record.housekeepingStatus === 'Clean' && !unavailable) summary.cleanRooms++;
      if (record.housekeepingStatus === 'Dirty' && !unavailable) summary.dirtyRooms++;
      if (isOutOfOrder(record)) summary.outOfOrderRooms++;
      if (record.housekeepingStatus === 'Maintenance') summary.maintenanceRooms++;
      if (unavailable) summary.unavailableRooms++;
      if (record.occupancyStatus === 'Occupied') summary.occupiedRooms++;
      if (record.occupancyStatus === 'Vacant') summary.vacantRooms++;
      if (record.pet) summary.roomsWithPets++;
    });
    res.json({ success: true, date: date || 'all', summary });
  } catch (error) {
    sendError(res, error, 'Failed to get housekeeping summary');
  }
};

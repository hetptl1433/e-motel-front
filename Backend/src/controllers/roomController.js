const mongoose = require('mongoose');
const RoomReport = require('../models/RoomReport');
const Housekeeper = require('../models/Housekeeper');
const { dateRange, normalizeFields, isRoomUnavailable, assertStaffCanClean, emitMutation, sendError, invalid, recordChanged, expectedVersion, assertExpectedVersion } = require('../utils/roomData');
const { sameValue, synchronizeRecord } = require('../utils/recordSync');

async function syncToHousekeeping(req, room, updates, { action = 'roomUpdate', ensureRecord = false, preserveCleaningTimestamps = false } = {}) {
  const date = new Date(room.reportDate).toISOString().slice(0, 10);
  try {
    const filter = { roomNumber: room.room, reportDate: dateRange(date) };
    const changes = { ...updates };
    if (!preserveCleaningTimestamps && updates.housekeepingStatus === 'Clean') changes.cleanedAt = new Date();
    if (!preserveCleaningTimestamps && updates.housekeepingStatus === 'Dirty') {
      changes.cleanedAt = null;
      changes.inspectedAt = null;
    }
    const changesFor = target => {
      if (action !== 'checkout') {
        const mirror = { ...changes };
        if (updates.housekeepingStatus === 'Clean' && target?.housekeepingStatus === 'Clean' && target.cleanedAt) delete mirror.cleanedAt;
        return mirror;
      }
      const checkout = { ...changes };
      // A retry must repair a missed checkout, without undoing cleaning that
      // already belongs to this checkout cycle.
      if (!sameValue(target?.checkedOutAt, room.checkedOutAt)) {
        Object.assign(checkout, { housekeepingStatus: isRoomUnavailable(room) ? room.housekeepingStatus : 'Dirty', cleanedAt: null, inspectedAt: null });
      } else {
        delete checkout.housekeepingStatus;
        delete checkout.cleanedAt;
        delete checkout.inspectedAt;
      }
      return checkout;
    };
    let initial;
    if (ensureRecord) {
      const source = room.toObject ? room.toObject() : room;
      initial = { ...normalizeFields(source, { housekeeping: true, imported: true, reportDate: date }), ...changesFor(null) };
    }
    const result = await synchronizeRecord({ SourceModel: RoomReport, TargetModel: Housekeeper, source: room, filter, changesFor, initial });
    if (result.changed) {
      emitMutation(req, 'housekeepingBulkUpdated', { action, date, data: result.data });
    }
  } catch (error) {
    console.error('Housekeeping synchronization failed:', error.message);
    return 'Room updated, but housekeeping synchronization failed. Refresh and try the change again.';
  }
}

exports.listRooms = async (req, res) => {
  try {
    const filter = req.query.date ? { reportDate: dateRange(req.query.date) } : {};
    const rooms = await RoomReport.find(filter).sort({ reportDate: -1, room: 1 });
    // Preserve the legacy list shape; date endpoints return a metadata envelope.
    res.json(rooms);
  } catch (error) {
    sendError(res, error, 'Failed to list rooms');
  }
};

exports.updateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isObjectIdOrHexString(id)) throw invalid('Invalid room ID format');
    const input = expectedVersion(req.body);
    const updates = normalizeFields(input.data, { partial: true, role: req.user?.role });
    if (updates.occupancyStatus === 'Occupied') updates.checkedOutAt = null;
    let updatedRoom;
    if (input.expectedUpdatedAt !== undefined || updates.occupancyStatus !== undefined || (req.user?.role === 'housekeeping' && ['Clean', 'Dirty'].includes(updates.housekeepingStatus))) {
      const current = await RoomReport.findById(id);
      if (!current) return res.status(404).json({ success: false, message: 'Room not found' });
      assertExpectedVersion(current, input.expectedUpdatedAt);
      assertStaffCanClean(current, updates, req.user?.role);
      if (updates.occupancyStatus !== undefined && updates.occupancyStatus !== current.occupancyStatus) updates.stayoverServicedAt = null;
      updatedRoom = await RoomReport.findOneAndUpdate({ _id: id, updatedAt: current.updatedAt ?? null }, { $set: updates }, { new: true, runValidators: true });
      if (!updatedRoom) throw recordChanged();
    } else {
      updatedRoom = await RoomReport.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });
    }
    if (!updatedRoom) return res.status(404).json({ success: false, message: 'Room not found' });
    const date = new Date(updatedRoom.reportDate).toISOString().slice(0, 10);

    // Keep imported housekeeping records aligned with explicit front desk edits.
    // A secondary synchronization failure must not hide the successful primary update.
    const syncWarning = await syncToHousekeeping(req, updatedRoom, updates);
    emitMutation(req, 'roomStatusUpdated', { action: 'update', date, data: updatedRoom });
    res.json({ success: true, data: updatedRoom, ...(syncWarning && { warning: syncWarning }) });
  } catch (error) {
    sendError(res, error, 'Failed to update room');
  }
};

exports.checkoutRoom = async (req, res) => {
  try {
    if (!['frontdesk', 'admin'].includes(req.user?.role)) {
      return res.status(403).json({ success: false, message: 'Only the front desk or an administrator can check out a guest' });
    }
    const { id } = req.params;
    if (!mongoose.isObjectIdOrHexString(id)) throw invalid('Invalid room ID format');
    const { expectedUpdatedAt } = expectedVersion(req.body || {});
    const current = await RoomReport.findById(id);
    if (!current) return res.status(404).json({ success: false, message: 'Room not found' });
    assertExpectedVersion(current, expectedUpdatedAt);
    let data = current;
    const repeated = Boolean(current.checkedOutAt);
    let didCheckout = false;
    if (!repeated) {
      if (current.occupancyStatus !== 'Occupied') return res.status(409).json({ success: false, message: 'This room is already vacant' });
      const updates = {
        occupancyStatus: 'Vacant', guestStatus: 'Checked-out', checkedOutAt: new Date(), stayoverServicedAt: null,
        // A checkout cannot release a maintenance or out-of-order room.
        housekeepingStatus: isRoomUnavailable(current) ? current.housekeepingStatus : 'Dirty'
      };
      data = await RoomReport.findOneAndUpdate(
        { _id: id, occupancyStatus: 'Occupied', checkedOutAt: null, updatedAt: current.updatedAt ?? null },
        { $set: updates }, { new: true, runValidators: true }
      );
      didCheckout = Boolean(data);
      if (!data) {
        // Two desk clients may click checkout together. Preserve the first result.
        data = await RoomReport.findById(id);
        if (!data?.checkedOutAt) return res.status(409).json({ success: false, message: 'The room changed. Refresh before checking out this guest' });
      }
    }
    const date = new Date(data.reportDate).toISOString().slice(0, 10);
    const changes = { occupancyStatus: data.occupancyStatus, housekeepingStatus: data.housekeepingStatus, guestStatus: data.guestStatus, checkedOutAt: data.checkedOutAt, stayoverServicedAt: null };
    if (!didCheckout) delete changes.housekeepingStatus;
    if (didCheckout) Object.assign(changes, { cleanedAt: null, inspectedAt: null });
    const warning = await syncToHousekeeping(req, data, changes, { action: 'checkout', ensureRecord: true, preserveCleaningTimestamps: true });
    emitMutation(req, 'roomStatusUpdated', { action: 'checkout', date, data });
    res.json({ success: true, data, ...(warning && { warning }) });
  } catch (error) {
    sendError(res, error, 'Failed to check out room');
  }
};

exports.createRoom = async (req, res) => {
  try {
    const data = normalizeFields(req.body);
    const date = data.reportDate.toISOString().slice(0, 10);
    if (await RoomReport.exists({ room: data.room, reportDate: dateRange(date) })) {
      return res.status(409).json({ success: false, message: 'A room report already exists for this room and date' });
    }
    const newRoom = await RoomReport.create(data);
    emitMutation(req, 'roomRecordCreated', { action: 'create', date, data: newRoom });
    res.status(201).json({ success: true, data: newRoom });
  } catch (error) {
    sendError(res, error, 'Failed to create room');
  }
};

exports.getRoomsByDate = async (req, res) => {
  try {
    const { date } = req.params;
    const rooms = await RoomReport.find({ reportDate: dateRange(date) }).sort({ room: 1 });
    res.json({ success: true, count: rooms.length, date, data: rooms });
  } catch (error) {
    sendError(res, error, 'Failed to fetch room reports');
  }
};

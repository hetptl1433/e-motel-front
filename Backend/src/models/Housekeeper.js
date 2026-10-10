const mongoose = require('mongoose');
const { HOUSEKEEPING_STATUSES, OCCUPANCY_STATUSES, normalizeRoomNumber, normalizeHousekeepingStatus, normalizeOccupancyStatus } = require('../utils/roomData');

const housekeeperSchema = new mongoose.Schema({
  roomNumber: { type: String, required: true, set: normalizeRoomNumber },
  type: { type: String, trim: true },
  housekeepingStatus: { type: String, enum: HOUSEKEEPING_STATUSES, default: 'Dirty', set: normalizeHousekeepingStatus },
  occupancyStatus: { type: String, enum: OCCUPANCY_STATUSES, default: 'Vacant', set: normalizeOccupancyStatus },
  guestStatus: { type: String, trim: true },
  checkIn: { type: String, trim: true },
  checkOut: { type: String, trim: true },
  checkedOutAt: Date,
  orderStatus: { type: String, trim: true },
  reason: { type: String, trim: true },
  description: { type: String, trim: true },
  assignedAttendant: { type: String, trim: true },
  notes: { type: String, trim: true },
  cleanedAt: Date,
  inspectedAt: Date,
  issues: [String],
  photos: [String],
  pet: { type: Boolean, default: false },
  importDate: { type: Date, default: Date.now },
  reportDate: { type: Date, required: true, index: true }
}, { timestamps: true });

housekeeperSchema.index({ roomNumber: 1, reportDate: 1 });
module.exports = mongoose.model('Housekeeper', housekeeperSchema);

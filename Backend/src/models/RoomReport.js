const mongoose = require('mongoose');
const { HOUSEKEEPING_STATUSES, OCCUPANCY_STATUSES, normalizeRoomNumber, normalizeHousekeepingStatus, normalizeOccupancyStatus } = require('../utils/roomData');

const roomReportSchema = new mongoose.Schema({
  room: { type: String, required: true, set: normalizeRoomNumber },
  type: { type: String, trim: true },
  housekeepingStatus: { type: String, enum: HOUSEKEEPING_STATUSES, default: 'Dirty', set: normalizeHousekeepingStatus },
  occupancyStatus: { type: String, enum: OCCUPANCY_STATUSES, default: 'Vacant', set: normalizeOccupancyStatus },
  guestStatus: { type: String, trim: true },
  checkIn: { type: String, trim: true },
  checkOut: { type: String, trim: true },
  checkedOutAt: Date,
  stayoverServicedAt: Date,
  orderStatus: { type: String, trim: true },
  reason: { type: String, trim: true },
  description: { type: String, trim: true },
  assignedAttendant: { type: String, trim: true },
  notes: { type: String, trim: true },
  pet: { type: Boolean, default: false },
  reportDate: { type: Date, required: true, index: true }
}, { timestamps: true });

// Old installations may contain duplicate reports. A migration is required before making this unique.
roomReportSchema.index({ room: 1, reportDate: 1 });
module.exports = mongoose.model('RoomReport', roomReportSchema);
